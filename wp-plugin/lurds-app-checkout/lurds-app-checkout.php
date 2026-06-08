<?php
/**
 * Plugin Name: Lurd's App Checkout
 * Description: Recebe pedidos do app PWA (app.lurds.com.br) e prepara o carrinho do WC pra checkout nativo. Resolve o problema de "métodos de pagamento indisponíveis" que acontece quando se cria pedido via REST API + redireciona pra order-pay.
 * Version:     1.0.0
 * Author:      Lurd's
 * Requires PHP: 7.4
 *
 * COMO FUNCIONA:
 *   1. App PWA monta o checkout (endereço, frete, cashback, etc).
 *   2. Backend NestJS chama POST /wp-json/lurds-app/v1/checkout com items + dados.
 *   3. Plugin esvazia carrinho do WC, adiciona produtos via WC()->cart->add_to_cart()
 *      (caminho nativo — gateways de pagamento reconhecem normalmente).
 *   4. Aplica cashback como FEE negativo.
 *   5. Salva endereço de billing na sessão.
 *   6. Gera URL única (token) e retorna pro app.
 *   7. App redireciona cliente pra essa URL → checkout WC nativo → pagamento funciona.
 *
 * SEGURANÇA:
 *   - Endpoint protegido por API key (constant LURDS_APP_CHECKOUT_KEY no wp-config.php)
 *   - Token de sessão expira em 30 minutos
 */

if (!defined('ABSPATH')) exit;

class Lurds_App_Checkout {

    const VERSION   = '1.0.0';
    const NAMESPACE = 'lurds-app/v1';
    const SESSION_KEY = 'lurds_app_checkout_token';
    const TOKEN_TTL = 1800; // 30 min

    public function __construct() {
        add_action('rest_api_init', [$this, 'register_routes']);
        add_action('template_redirect', [$this, 'maybe_apply_session']);
    }

    /* ─────────────────────── ROTAS REST ─────────────────────── */

    public function register_routes() {
        register_rest_route(self::NAMESPACE, '/checkout', [
            'methods'             => 'POST',
            'callback'            => [$this, 'handle_checkout'],
            'permission_callback' => [$this, 'check_api_key'],
        ]);

        register_rest_route(self::NAMESPACE, '/ping', [
            'methods'             => 'GET',
            'callback'            => function () {
                return [
                    'ok'        => true,
                    'version'   => self::VERSION,
                    'wc_active' => class_exists('WooCommerce'),
                ];
            },
            'permission_callback' => '__return_true',
        ]);
    }

    public function check_api_key(WP_REST_Request $req) {
        $key = $req->get_header('x-lurds-app-key');
        $expected = defined('LURDS_APP_CHECKOUT_KEY') ? LURDS_APP_CHECKOUT_KEY : '';
        if (empty($expected)) {
            return new WP_Error('config', 'LURDS_APP_CHECKOUT_KEY não configurado no wp-config.php', ['status' => 500]);
        }
        if (!hash_equals($expected, $key ?: '')) {
            return new WP_Error('auth', 'API key inválida', ['status' => 401]);
        }
        return true;
    }

    /* ─────────────────────── HANDLER PRINCIPAL ─────────────────────── */

    public function handle_checkout(WP_REST_Request $req) {
        if (!class_exists('WooCommerce')) {
            return new WP_Error('wc', 'WooCommerce não está ativo', ['status' => 500]);
        }

        $body = $req->get_json_params();
        if (empty($body['items']) || !is_array($body['items'])) {
            return new WP_Error('items', 'items obrigatório (array)', ['status' => 400]);
        }

        // Gera token único pra essa sessão de checkout
        $token = wp_generate_password(32, false, false);

        // Monta payload que será aplicado quando cliente acessar a URL
        $payload = [
            'token'              => $token,
            'created'            => time(),
            'expires'            => time() + self::TOKEN_TTL,
            'items'              => array_map(function ($i) {
                return [
                    'product_id'   => intval($i['product_id'] ?? 0),
                    'variation_id' => intval($i['variation_id'] ?? 0),
                    'quantity'     => max(1, intval($i['quantity'] ?? 1)),
                ];
            }, $body['items']),
            'customer'           => $body['customer'] ?? [],
            'shipping'           => $body['shipping'] ?? [],
            'cashback_cents'     => intval($body['cashback_cents'] ?? 0),
            'pickup_store_code'  => sanitize_text_field($body['pickup_store_code'] ?? ''),
            'payment_pref'       => sanitize_text_field($body['payment_pref'] ?? ''),
        ];

        // Guarda em transient (expira sozinho)
        set_transient('lurds_app_checkout_' . $token, $payload, self::TOKEN_TTL);

        // Monta URL pra cliente abrir (carrinho do WC)
        $url = add_query_arg('lurds_app_token', $token, wc_get_cart_url());

        return [
            'ok'        => true,
            'token'     => $token,
            'checkout_url' => $url,
            'expires_at' => $payload['expires'],
        ];
    }

    /* ─────────────────── APLICA SESSÃO QUANDO CLIENTE ABRE A URL ─────────────────── */

    public function maybe_apply_session() {
        if (empty($_GET['lurds_app_token'])) return;
        if (!class_exists('WooCommerce')) return;
        if (is_admin()) return;

        $token = sanitize_text_field($_GET['lurds_app_token']);
        $payload = get_transient('lurds_app_checkout_' . $token);
        if (!$payload) {
            // Token expirado — segue fluxo normal (cliente vai pro carrinho vazio)
            wc_add_notice('Esse link de checkout expirou. Adicione os produtos ao carrinho novamente.', 'error');
            return;
        }

        // Evita aplicar 2x na mesma sessão (cliente recarregou a página)
        if (WC()->session && WC()->session->get(self::SESSION_KEY) === $token) {
            return;
        }

        // 1) Esvazia carrinho atual (cliente pode ter outras coisas de outra sessão)
        WC()->cart->empty_cart();

        // 2) Adiciona produtos
        $added_count = 0;
        foreach ($payload['items'] as $it) {
            $variation_id = $it['variation_id'] ?: 0;
            $variation_data = [];
            // Se for variação, pega os attributes corretos pra add_to_cart
            if ($variation_id) {
                $variation = wc_get_product($variation_id);
                if ($variation && $variation->is_type('variation')) {
                    $variation_data = $variation->get_variation_attributes();
                }
            }
            $added = WC()->cart->add_to_cart(
                $it['product_id'],
                $it['quantity'],
                $variation_id,
                $variation_data
            );
            if ($added) $added_count++;
        }

        if ($added_count === 0) {
            wc_add_notice('Não conseguimos adicionar os produtos ao carrinho. Tente novamente pelo app.', 'error');
            return;
        }

        // 3) Aplica cashback como FEE negativo via hook do carrinho
        $cashback_cents = intval($payload['cashback_cents']);
        if ($cashback_cents > 0) {
            // Salva pra ser aplicado em todo refresh do carrinho/checkout
            WC()->session->set('lurds_app_cashback_cents', $cashback_cents);
        }

        // 4) Salva billing/shipping na sessão pra preencher checkout
        $customer = $payload['customer'];
        $shipping = $payload['shipping'];
        if (!empty($customer) || !empty($shipping)) {
            $cpf = isset($customer['cpf']) ? preg_replace('/\D/', '', $customer['cpf']) : '';
            $first = $customer['first_name'] ?? '';
            $last  = $customer['last_name'] ?? '';
            $fields = [
                'billing_first_name' => $first,
                'billing_last_name'  => $last,
                'billing_email'      => $customer['email'] ?? '',
                'billing_phone'      => $customer['phone'] ?? '',
                'billing_cpf'        => $cpf,
                'billing_persontype' => '1',
                'shipping_first_name' => $first,
                'shipping_last_name'  => $last,
            ];
            // Endereço (vai pra billing E shipping)
            if (!empty($shipping)) {
                $addr1 = $shipping['address_1'] ?? '';
                $addr_num = $shipping['number'] ?? '';
                $addr2 = trim(($addr_num ? $addr_num . ' ' : '') . ($shipping['address_2'] ?? ''));
                $fields['billing_address_1']  = $addr1;
                $fields['billing_address_2']  = $addr2;
                $fields['billing_city']       = $shipping['city'] ?? '';
                $fields['billing_state']      = strtoupper(substr($shipping['state'] ?? 'SP', 0, 2));
                $fields['billing_postcode']   = $shipping['postcode'] ?? '';
                $fields['billing_country']    = $shipping['country'] ?? 'BR';
                $fields['shipping_address_1'] = $addr1;
                $fields['shipping_address_2'] = $addr2;
                $fields['shipping_city']      = $shipping['city'] ?? '';
                $fields['shipping_state']     = strtoupper(substr($shipping['state'] ?? 'SP', 0, 2));
                $fields['shipping_postcode']  = $shipping['postcode'] ?? '';
                $fields['shipping_country']   = $shipping['country'] ?? 'BR';
            }
            foreach ($fields as $k => $v) {
                if ($v !== '' && WC()->customer && method_exists(WC()->customer, "set_$k")) {
                    WC()->customer->{"set_$k"}($v);
                }
                if (WC()->session) {
                    WC()->session->set('customer_' . $k, $v);
                }
            }
            if (WC()->customer) WC()->customer->save();
        }

        // 5) Marca sessão como aplicada
        WC()->session->set(self::SESSION_KEY, $token);
        WC()->session->set('lurds_app_pickup_store', $payload['pickup_store_code']);

        // Limpa transient — usado, não precisa mais
        delete_transient('lurds_app_checkout_' . $token);

        // 6) Redireciona pro checkout direto (skipa o carrinho)
        wp_safe_redirect(wc_get_checkout_url());
        exit;
    }
}

new Lurds_App_Checkout();

/* ─────────────────── HOOK: APLICA CASHBACK COMO FEE NEGATIVO ─────────────────── */
add_action('woocommerce_cart_calculate_fees', function ($cart) {
    if (is_admin() && !defined('DOING_AJAX')) return;
    if (!WC()->session) return;
    $cents = intval(WC()->session->get('lurds_app_cashback_cents', 0));
    if ($cents <= 0) return;

    // Limita a 50% do subtotal — política de cashback
    $subtotal = $cart->get_subtotal();
    $max     = $subtotal * 0.5;
    $value   = min($cents / 100, $max);

    if ($value > 0) {
        $cart->add_fee('Cashback Lurd\'s', -$value, false);
    }
}, 10, 1);

/* ─────────────────── HOOK: FORÇA "RETIRAR EM LOJA" QUANDO ESCOLHIDO NO APP ─────────────────── */
// Quando cliente escolheu pickup no app, substitui TODOS os métodos de frete
// por um único: "Retirar na loja X" com custo R$ 0.
add_filter('woocommerce_package_rates', function ($rates, $package) {
    if (!WC()->session) return $rates;
    $pickup_code = WC()->session->get('lurds_app_pickup_store');
    if (empty($pickup_code)) return $rates;

    // Limpa zone rates e adiciona método pickup customizado
    $label = 'Retirar na loja Lurd\'s ' . esc_html($pickup_code);
    $rate = new WC_Shipping_Rate(
        'lurds_app_pickup',
        $label,
        0,
        [],
        'local_pickup'
    );
    return ['lurds_app_pickup' => $rate];
}, 999, 2);

/* ─────────────────── HOOK: PRESERVA SESSÃO ENTRE PÁGINAS WC ─────────────────── */
// Quando cliente recarrega o checkout, garante que o método de frete pickup
// está selecionado (caso contrário ele cai pro PAC/SEDEX padrão).
add_action('woocommerce_checkout_update_order_review', function ($post_data) {
    if (!WC()->session) return;
    $pickup_code = WC()->session->get('lurds_app_pickup_store');
    if (!empty($pickup_code)) {
        WC()->session->set('chosen_shipping_methods', ['lurds_app_pickup']);
    }
});

/* ─────────────────── HOOK: META_DATA NO PEDIDO (origem app) ─────────────────── */
add_action('woocommerce_checkout_create_order', function ($order, $data) {
    if (!WC()->session) return;
    $token = WC()->session->get(Lurds_App_Checkout::SESSION_KEY);
    if (!$token) return;

    $order->update_meta_data('_app_origin', 'app.lurds.com.br');
    $cents = intval(WC()->session->get('lurds_app_cashback_cents', 0));
    if ($cents > 0) {
        $order->update_meta_data('_app_cashback_used_cents', $cents);
    }
    $pickup = WC()->session->get('lurds_app_pickup_store');
    if ($pickup) {
        $order->update_meta_data('_pickup_store_code', $pickup);
    }
}, 10, 2);

/* ─────────────────── HOOK: LIMPA SESSÃO APÓS FINALIZAR ─────────────────── */
add_action('woocommerce_thankyou', function ($order_id) {
    if (WC()->session) {
        WC()->session->set('lurds_app_cashback_cents', 0);
        WC()->session->set('lurds_app_pickup_store', '');
        WC()->session->set(Lurds_App_Checkout::SESSION_KEY, '');
    }
});
