<?php
/**
 * Plugin Name: FlowOps — Abandoned Carts Bridge
 * Description: Expõe dados do plugin "Cart Abandonment Recovery for WooCommerce" (CartFlows) para o FlowOps Lite via REST autenticada. Read-only.
 * Version:     1.0.0
 * Author:      FlowOps
 *
 * INSTALAÇÃO
 *   1) Coloque este arquivo em:  wp-content/mu-plugins/flowops-abandoned-carts.php
 *      (se a pasta mu-plugins não existir, crie.)
 *   2) Troque a constante FLOWOPS_WP_KEY abaixo por uma chave secreta.
 *   3) Cole a MESMA chave no .env do backend do FlowOps como FLOWOPS_WP_KEY,
 *      e a URL base como FLOWOPS_WP_BASE=https://seu-site.com/wp-json
 *
 * TESTE RÁPIDO (via browser):
 *   https://seu-site.com/wp-json/flowops/v1/ping?key=SUA_CHAVE
 *
 * ROTAS
 *   GET /wp-json/flowops/v1/ping                          — health check
 *   GET /wp-json/flowops/v1/abandoned-carts/schema        — diagnóstico (nome da tabela, colunas, 3 linhas)
 *   GET /wp-json/flowops/v1/abandoned-carts/list          — lista paginada
 *     ?page=1&per_page=50&status=&since=YYYY-MM-DD&until=YYYY-MM-DD&search=
 *     status: 'normal' | 'abandoned' | 'completed' | 'lost'  (vazio = todos)
 *   GET /wp-json/flowops/v1/abandoned-carts/detail/:id    — detalhe com carrinho deserializado
 *   GET /wp-json/flowops/v1/abandoned-carts/stats         — KPIs agregados
 *     ?since=YYYY-MM-DD
 */

if (!defined('ABSPATH')) {
    exit;
}

// ============================================================
//  CONFIG  —  ⚠️ TROQUE A CHAVE ABAIXO!  ⚠️
// ============================================================
//
// Sugestão de chave aleatória (use esta ou gere outra de 64 chars hex):
define('FLOWOPS_WP_KEY', '88cc82148fce9dca91c3477f0de194f8afb5b242a5ac5f786b49501caa523764');
// ============================================================


/** Valida a API key via header X-FlowOps-Key OU query ?key=... */
function flowops_check_key(WP_REST_Request $req) {
    $provided = $req->get_header('X-FlowOps-Key');
    if (!$provided) $provided = $req->get_param('key');
    if (!$provided) return new WP_Error('no_key', 'API key missing', ['status' => 401]);
    if (!hash_equals(FLOWOPS_WP_KEY, (string) $provided)) {
        return new WP_Error('bad_key', 'Invalid key', ['status' => 401]);
    }
    return true;
}

/** Descobre o nome real da tabela do plugin Cart Abandonment Recovery. */
function flowops_cart_table() {
    global $wpdb;
    $prefix = $wpdb->prefix;
    $candidates = [
        $prefix . 'cartflows_ca_cart_abandonment',  // CartFlows (versão atual)
        $prefix . 'cart_abandonment',               // fallback genérico
    ];
    foreach ($candidates as $t) {
        $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $t);
        if ($wpdb->get_var($sql)) return $t;
    }
    // Último fallback: procura qualquer tabela com "cart_abandonment" no nome.
    $like = '%cart_abandonment%';
    $sql = $wpdb->prepare('SHOW TABLES LIKE %s', $like);
    $found = $wpdb->get_var($sql);
    return $found ?: null;
}

/**
 * Deserialize do cart_contents (PHP serialized) e do other_fields (JSON).
 * Retorna arrays "limpos" pro FlowOps consumir direto.
 */
function flowops_unpack_cart_contents($raw) {
    if (!$raw) return [];
    // suppress_errors pra não poluir log se vier corrompido.
    $data = @unserialize($raw);
    if (!is_array($data)) return [];
    $items = [];
    foreach ($data as $key => $item) {
        if (!is_array($item)) continue;
        $items[] = [
            'product_id'   => isset($item['product_id'])   ? (int) $item['product_id']   : null,
            'variation_id' => isset($item['variation_id']) ? (int) $item['variation_id'] : null,
            'quantity'     => isset($item['quantity'])     ? (int) $item['quantity']     : null,
            'line_total'   => isset($item['line_total'])   ? (float) $item['line_total'] : null,
            'line_subtotal'=> isset($item['line_subtotal'])? (float) $item['line_subtotal']: null,
            'sku'          => isset($item['sku'])          ? (string) $item['sku']       : null,
            'name'         => isset($item['name'])         ? (string) $item['name']      : null,
        ];
    }
    return $items;
}

function flowops_unpack_other_fields($raw) {
    if (!$raw) return [];
    $obj = json_decode($raw, true);
    if (!is_array($obj)) return [];
    // Whitelist dos campos comuns do CartFlows.
    $out = [];
    $fields = [
        'wcf_first_name', 'wcf_last_name', 'wcf_phone_number',
        'wcf_billing_company', 'wcf_location',
        'wcf_billing_address_1', 'wcf_billing_address_2',
        'wcf_billing_city', 'wcf_billing_state', 'wcf_billing_postcode', 'wcf_billing_country',
        'wcf_order_bump_products', 'wcf_user_id',
    ];
    foreach ($fields as $f) {
        if (array_key_exists($f, $obj)) $out[$f] = $obj[$f];
    }
    // Também devolve o bruto pra debug, caso tenha algum campo novo.
    $out['_raw'] = $obj;
    return $out;
}

/** Monta a cláusula WHERE padrão pros endpoints de lista/stats. */
function flowops_build_where(WP_REST_Request $req, array &$params) {
    $where = '1=1';
    $status = trim((string) $req->get_param('status'));
    $since  = trim((string) $req->get_param('since'));
    $until  = trim((string) $req->get_param('until'));
    $search = trim((string) $req->get_param('search'));

    if ($status !== '') {
        $where .= ' AND order_status = %s';
        $params[] = $status;
    }
    if ($since !== '') {
        $where .= ' AND time >= %s';
        $params[] = $since . ' 00:00:00';
    }
    if ($until !== '') {
        $where .= ' AND time <= %s';
        $params[] = $until . ' 23:59:59';
    }
    if ($search !== '') {
        // busca em email + other_fields (onde vai o nome/tel)
        $where .= ' AND (email LIKE %s OR other_fields LIKE %s)';
        $like = '%' . $search . '%';
        $params[] = $like;
        $params[] = $like;
    }
    return $where;
}


// =========================================================================
//  ROTAS
// =========================================================================
add_action('rest_api_init', function () {

    // --- ping -------------------------------------------------------------
    register_rest_route('flowops/v1', '/ping', [
        'methods'             => 'GET',
        'permission_callback' => 'flowops_check_key',
        'callback'            => function () {
            return ['ok' => true, 'pong' => time()];
        },
    ]);

    // --- schema (diagnóstico) --------------------------------------------
    register_rest_route('flowops/v1', '/abandoned-carts/schema', [
        'methods'             => 'GET',
        'permission_callback' => 'flowops_check_key',
        'callback'            => function () {
            global $wpdb;
            $table = flowops_cart_table();
            if (!$table) {
                return [
                    'ok'     => false,
                    'error'  => 'Tabela de carrinhos abandonados não encontrada.',
                    'prefix' => $wpdb->prefix,
                ];
            }
            $cols   = $wpdb->get_results("SHOW COLUMNS FROM `$table`", ARRAY_A);
            $count  = (int) $wpdb->get_var("SELECT COUNT(*) FROM `$table`");
            $sample = $wpdb->get_results("SELECT * FROM `$table` ORDER BY id DESC LIMIT 3", ARRAY_A);
            return [
                'ok'       => true,
                'table'    => $table,
                'rowCount' => $count,
                'columns'  => $cols,
                'sample'   => $sample,
            ];
        },
    ]);

    // --- list (paginado) --------------------------------------------------
    register_rest_route('flowops/v1', '/abandoned-carts/list', [
        'methods'             => 'GET',
        'permission_callback' => 'flowops_check_key',
        'callback'            => function (WP_REST_Request $req) {
            global $wpdb;
            $table = flowops_cart_table();
            if (!$table) return ['ok' => false, 'error' => 'Tabela não encontrada'];

            $page    = max(1, (int) $req->get_param('page'));
            $perPage = min(200, max(1, (int) ($req->get_param('per_page') ?: 50)));
            $offset  = ($page - 1) * $perPage;

            $params = [];
            $where  = flowops_build_where($req, $params);

            // Total
            $totalSql = "SELECT COUNT(*) FROM `$table` WHERE $where";
            $total    = (int) $wpdb->get_var(empty($params) ? $totalSql : $wpdb->prepare($totalSql, $params));

            // Data
            $dataSql = "SELECT * FROM `$table` WHERE $where ORDER BY time DESC LIMIT %d OFFSET %d";
            $dataParams = array_merge($params, [$perPage, $offset]);
            $rows = $wpdb->get_results($wpdb->prepare($dataSql, $dataParams), ARRAY_A);

            // Simplifica: remove campos pesados da listagem (carrinho/other_fields).
            // Só contamos os itens e extraímos nome+telefone dos other_fields pra preview.
            $items = [];
            foreach ($rows as $r) {
                $cart  = flowops_unpack_cart_contents($r['cart_contents'] ?? null);
                $extra = flowops_unpack_other_fields($r['other_fields'] ?? null);
                $items[] = [
                    'id'             => (int) $r['id'],
                    'email'          => $r['email'] ?? null,
                    'first_name'     => $extra['wcf_first_name']     ?? null,
                    'last_name'      => $extra['wcf_last_name']      ?? null,
                    'phone'          => $extra['wcf_phone_number']   ?? null,
                    'city'           => $extra['wcf_billing_city']   ?? null,
                    'state'          => $extra['wcf_billing_state']  ?? null,
                    'order_status'   => $r['order_status']           ?? null,
                    'cart_total'     => isset($r['cart_total']) ? (float) $r['cart_total'] : null,
                    'items_count'    => count($cart),
                    'unsubscribed'   => isset($r['unsubscribed']) ? (int) $r['unsubscribed'] : 0,
                    'checkout_id'    => isset($r['checkout_id']) ? (int) $r['checkout_id'] : null,
                    'order_id'       => isset($r['order_id']) ? (int) $r['order_id'] : null,
                    'session_id'     => $r['session_id'] ?? null,
                    'time'           => $r['time'] ?? null,
                ];
            }

            return [
                'ok'         => true,
                'total'      => $total,
                'page'       => $page,
                'per_page'   => $perPage,
                'total_pages'=> (int) ceil($total / $perPage),
                'items'      => $items,
            ];
        },
    ]);

    // --- detail -----------------------------------------------------------
    register_rest_route('flowops/v1', '/abandoned-carts/detail/(?P<id>\d+)', [
        'methods'             => 'GET',
        'permission_callback' => 'flowops_check_key',
        'callback'            => function (WP_REST_Request $req) {
            global $wpdb;
            $table = flowops_cart_table();
            if (!$table) return ['ok' => false, 'error' => 'Tabela não encontrada'];

            $id = (int) $req['id'];
            $row = $wpdb->get_row(
                $wpdb->prepare("SELECT * FROM `$table` WHERE id = %d", $id),
                ARRAY_A
            );
            if (!$row) return new WP_Error('not_found', 'Carrinho não encontrado', ['status' => 404]);

            $cart  = flowops_unpack_cart_contents($row['cart_contents'] ?? null);
            $extra = flowops_unpack_other_fields($row['other_fields'] ?? null);

            return [
                'ok'           => true,
                'id'           => (int) $row['id'],
                'email'        => $row['email']        ?? null,
                'order_status' => $row['order_status'] ?? null,
                'cart_total'   => isset($row['cart_total']) ? (float) $row['cart_total'] : null,
                'session_id'   => $row['session_id']   ?? null,
                'checkout_id'  => isset($row['checkout_id']) ? (int) $row['checkout_id'] : null,
                'order_id'     => isset($row['order_id']) ? (int) $row['order_id'] : null,
                'unsubscribed' => isset($row['unsubscribed']) ? (int) $row['unsubscribed'] : 0,
                'time'         => $row['time'] ?? null,
                'cart_items'   => $cart,
                'other_fields' => $extra,
            ];
        },
    ]);

    // --- stats ------------------------------------------------------------
    register_rest_route('flowops/v1', '/abandoned-carts/stats', [
        'methods'             => 'GET',
        'permission_callback' => 'flowops_check_key',
        'callback'            => function (WP_REST_Request $req) {
            global $wpdb;
            $table = flowops_cart_table();
            if (!$table) return ['ok' => false, 'error' => 'Tabela não encontrada'];

            $since = trim((string) $req->get_param('since'));
            $whereDate = '1=1';
            $params = [];
            if ($since !== '') {
                $whereDate = 'time >= %s';
                $params[] = $since . ' 00:00:00';
            }

            $sql = "
                SELECT order_status AS status,
                       COUNT(*)     AS qty,
                       COALESCE(SUM(cart_total), 0) AS total
                  FROM `$table`
                 WHERE $whereDate
              GROUP BY order_status
            ";
            $rows = empty($params)
                ? $wpdb->get_results($sql, ARRAY_A)
                : $wpdb->get_results($wpdb->prepare($sql, $params), ARRAY_A);

            $buckets = [
                'abandoned' => ['qty' => 0, 'total' => 0.0],
                'completed' => ['qty' => 0, 'total' => 0.0],
                'lost'      => ['qty' => 0, 'total' => 0.0],
                'normal'    => ['qty' => 0, 'total' => 0.0],
            ];
            $totalAll = 0;
            $totalValue = 0.0;
            foreach ($rows as $r) {
                $status = $r['status'] ?: 'normal';
                if (!isset($buckets[$status])) $buckets[$status] = ['qty' => 0, 'total' => 0.0];
                $buckets[$status]['qty']   = (int) $r['qty'];
                $buckets[$status]['total'] = (float) $r['total'];
                $totalAll   += (int) $r['qty'];
                $totalValue += (float) $r['total'];
            }

            // Recovery rate = completed / (completed + abandoned + lost)
            $baseRecov = $buckets['completed']['qty'] + $buckets['abandoned']['qty'] + $buckets['lost']['qty'];
            $recoveryRate = $baseRecov > 0
                ? round(($buckets['completed']['qty'] / $baseRecov) * 100, 2)
                : 0.0;

            return [
                'ok'           => true,
                'since'        => $since ?: null,
                'total_all'    => $totalAll,
                'total_value'  => $totalValue,
                'by_status'    => $buckets,
                'recovery_rate'=> $recoveryRate,
            ];
        },
    ]);
});
