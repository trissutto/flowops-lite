import Image from 'next/image';

const whatsapp = 'https://wa.me/5513996218277?text=Ol%C3%A1%2C%20quero%20fazer%20uma%20reserva%20no%20Esquina%20013.';

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#inicio" aria-label="Esquina 013 — início">
          <Image src="/images/logo-esquina013.png" alt="Esquina 013" width={220} height={147} priority />
        </a>
        <nav aria-label="Navegação principal">
          <a href="#experiencia">Experiência</a><a href="#programacao">Programação</a>
          <a href="#cardapio">Cardápio</a><a href="#contato">Contato</a>
        </nav>
        <details className="mobile-nav">
          <summary aria-label="Abrir menu">Menu</summary>
          <div><a href="#experiencia">Experiência</a><a href="#programacao">Programação</a><a href="#cardapio">Cardápio</a><a href="#contato">Contato</a></div>
        </details>
        <a className="button button-small" href={whatsapp} target="_blank" rel="noreferrer">Reservar</a>
      </header>

      <section className="hero" id="inicio">
        <Image className="hero-image" src="/images/fachada-esquina013-dia-v2.png" alt="Esquina 013 em uma tarde de encontros" fill sizes="100vw" priority />
        <div className="hero-shade" /><div className="hero-glow" />
        <div className="hero-content">
          <p className="eyebrow">Lounge <i /> Beach <i /> Bar</p>
          <h1>Seu ponto de<br />encontro.</h1>
          <p className="hero-copy">Porções, drinks, música e boas histórias — do almoço ao último brinde.</p>
          <div className="hero-actions">
            <a className="button" href={whatsapp} target="_blank" rel="noreferrer">Reservar agora</a>
            <a className="button button-ghost" href="#programacao">Ver programação</a>
            <a className="text-link" href="#cardapio">Conhecer o cardápio <span>↘</span></a>
          </div>
        </div>
        <div className="hero-meta"><span>Sex • Sáb • Dom</span><span>09h — 23h</span><span>Itanhaém • SP</span></div>
        <a className="scroll-cue" href="#experiencia" aria-label="Rolar para a experiência">Vem para a esquina <b>↓</b></a>
      </section>

      <section className="intro" id="experiencia">
        <p className="section-number">01 — A EXPERIÊNCIA</p>
        <h2>Comer, brindar<br /><em>e encontrar.</em></h2>
        <p>Um bar descontraído para dividir porções, ouvir música e deixar o tempo passar em boa companhia.</p>
        <div className="pillars">
          <article><span>01</span><h3>Comer</h3><p>Porções caprichadas e sabores feitos para dividir no meio da mesa.</p></article>
          <article><span>02</span><h3>Brindar</h3><p>Cerveja gelada, chopp e drinks para acompanhar cada momento.</p></article>
          <article><span>03</span><h3>Encontrar</h3><p>Música, conversa e aquele clima de praia que faz o tempo passar.</p></article>
        </div>
      </section>

      <section className="schedule" id="programacao">
        <div className="section-heading"><p className="section-number">02 — PROGRAMAÇÃO</p><h2>Seu fim de semana<br /><em>tem endereço.</em></h2></div>
        <div className="day-grid">
          {[
            ['SEX', 'Sexta na Esquina', 'O fim de semana começa com porções, bebida gelada, conversa e música boa.'],
            ['SÁB', 'Sábado 013', 'Chegue cedo, escolha a mesa e aproveite o dia sem pressa com a sua turma.'],
            ['DOM', 'Domingo de boa', 'Almoço, encontro e fim de tarde para fechar a semana em boa companhia.'],
          ].map(([day, title, copy]) => (
            <article className="day-card" key={day}><strong>{day}</strong><div><small>09H — 23H</small><h3>{title}</h3><p>{copy}</p><a href={whatsapp} target="_blank" rel="noreferrer">Confirmar atração <span>↗</span></a></div></article>
          ))}
        </div>
      </section>

      <section className="menu-section" id="cardapio">
        <div className="menu-visual">
          <a href="/images/cardapio-esquina013.jpeg" target="_blank" aria-label="Abrir cardápio completo">
            <Image src="/images/cardapio-esquina013.jpeg" alt="Cardápio de porções, petiscos, combos e bebidas do Esquina 013" fill sizes="(max-width: 800px) 100vw, 50vw" />
          </a>
          <div className="menu-badge"><b>013</b><span>clique para<br />ampliar</span></div>
        </div>
        <div className="menu-copy">
          <p className="section-number">03 — CARDÁPIO</p><h2>Feito para<br /><em>dividir a mesa.</em></h2>
          <div className="menu-lines">
            <div><span>01</span><h3>Porções</h3><p>Batata, calabresa, frango, peixe, camarão e muito mais.</p></div>
            <div><span>02</span><h3>Cerveja & chopp</h3><p>Gelados do jeito certo para acompanhar o dia.</p></div>
            <div><span>03</span><h3>Combos & drinks</h3><p>Opções para dividir, brindar e ficar mais um pouco.</p></div>
          </div>
          <a className="button" href="/images/cardapio-esquina013.jpeg" target="_blank">Abrir cardápio completo</a>
        </div>
      </section>

      <section className="gallery" id="galeria">
        <div className="gallery-head"><p className="section-number">04 — ATMOSFERA</p><h2>Do dia ao<br /><em>último brinde.</em></h2></div>
        <div className="gallery-grid">
          <figure className="gallery-main"><Image src="/images/ambiente-esquina013.png" alt="Mesas do Esquina 013 com vista para a praia ao entardecer" fill sizes="70vw" /></figure>
          <figure className="gallery-detail detail-one"><Image src="/images/fachada-esquina013-dia-v2.png" alt="Fachada do Esquina 013 durante a tarde" fill sizes="30vw" /></figure>
          <figure className="gallery-detail detail-two"><Image src="/images/fachada-esquina013-real.jpeg" alt="Fachada iluminada do Esquina 013" fill sizes="30vw" /></figure>
        </div>
      </section>

      <section className="contact" id="contato">
        <div className="contact-copy"><p className="section-number">05 — ENCONTRE A GENTE</p><h2>O próximo encontro<br />começa <em>aqui.</em></h2></div>
        <div className="contact-grid">
          <div><small>ENDEREÇO</small><p>Avenida Doutor Edson Baptista de Andrade, 1216<br />Cibratel I — Itanhaém/SP</p><a className="text-link" href="https://www.google.com/maps/search/?api=1&query=Avenida+Doutor+Edson+Baptista+de+Andrade+1216+Cibratel+I+Itanhaem+SP" target="_blank" rel="noreferrer">Como chegar <span>↗</span></a></div>
          <div><small>FUNCIONAMENTO</small><p>Sexta, sábado e domingo<br />das 09h às 23h</p></div>
          <div><small>RESERVAS</small><p>(13) 99621-8277<br />Atendimento pelo WhatsApp</p><a className="button" href={whatsapp} target="_blank" rel="noreferrer">Reservar agora</a></div>
        </div>
      </section>

      <footer><Image src="/images/logo-esquina013.png" alt="Esquina 013 — Lounge Beach Bar" width={240} height={160} /><p>© 2026 Esquina 013. Todos os direitos reservados.</p><a href="#inicio">Voltar ao topo ↑</a></footer>
    </main>
  );
}
