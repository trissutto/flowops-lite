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
        <Image className="hero-image" src="/images/fachada-esquina013.png" alt="Fachada iluminada do Esquina 013" fill sizes="100vw" priority />
        <div className="hero-shade" /><div className="hero-glow" />
        <div className="hero-content">
          <p className="eyebrow">Lounge <i /> Beach <i /> Bar</p>
          <h1>A noite começa<br />na esquina.</h1>
          <p className="hero-copy">Gastronomia, drinks e música em uma experiência urbana com alma de praia.</p>
          <div className="hero-actions">
            <a className="button" href={whatsapp} target="_blank" rel="noreferrer">Reservar agora</a>
            <a className="button button-ghost" href="#programacao">Ver programação</a>
            <a className="text-link" href="#cardapio">Conhecer o cardápio <span>↘</span></a>
          </div>
        </div>
        <div className="hero-meta"><span>Sex • Sáb • Dom</span><span>09h — 23h</span><span>Itanhaém • SP</span></div>
        <a className="scroll-cue" href="#experiencia" aria-label="Rolar para a experiência">Role para sentir <b>↓</b></a>
      </section>

      <section className="intro" id="experiencia">
        <p className="section-number">01 — A EXPERIÊNCIA</p>
        <h2>O litoral encontra<br /><em>a noite.</em></h2>
        <p>Um ponto de encontro feito para desacelerar, brindar e viver bons momentos — do primeiro drink ao último beat.</p>
        <div className="pillars">
          <article><span>01</span><h3>Lounge</h3><p>Conforto, encontros e uma atmosfera que acompanha o ritmo da noite.</p></article>
          <article><span>02</span><h3>Beach</h3><p>A leveza do litoral traduzida em luz, sabores e liberdade.</p></article>
          <article><span>03</span><h3>Bar</h3><p>Drinks marcantes, gastronomia para compartilhar e boa música.</p></article>
        </div>
      </section>

      <section className="schedule" id="programacao">
        <div className="section-heading"><p className="section-number">02 — PROGRAMAÇÃO</p><h2>Seu fim de semana<br /><em>tem endereço.</em></h2></div>
        <div className="day-grid">
          {[
            ['SEX', 'Sexta na Esquina', 'Comece o fim de semana com drinks, gastronomia e a trilha perfeita para entrar no clima.'],
            ['SÁB', 'Sábado 013', 'A noite ganha intensidade em uma experiência feita para celebrar e ficar até o último beat.'],
            ['DOM', 'Domingo Sunset', 'Um encontro leve para curtir o litoral, brindar e fechar a semana em boa companhia.'],
          ].map(([day, title, copy]) => (
            <article className="day-card" key={day}><strong>{day}</strong><div><small>09H — 23H</small><h3>{title}</h3><p>{copy}</p><a href={whatsapp} target="_blank" rel="noreferrer">Confirmar atração <span>↗</span></a></div></article>
          ))}
        </div>
      </section>

      <section className="menu-section" id="cardapio">
        <div className="menu-visual">
          <Image src="/images/fachada-esquina013.png" alt="Atmosfera iluminada do Esquina 013" fill sizes="(max-width: 800px) 100vw, 50vw" />
          <div className="menu-badge"><b>013</b><span>sabores<br />da esquina</span></div>
        </div>
        <div className="menu-copy">
          <p className="section-number">03 — CARDÁPIO</p><h2>Sabores que<br /><em>acendem a noite.</em></h2>
          <div className="menu-lines">
            <div><span>01</span><h3>Drinks autorais</h3><p>Clássicos revisitados e criações com personalidade.</p></div>
            <div><span>02</span><h3>Gastronomia</h3><p>Sabores preparados para transformar cada encontro.</p></div>
            <div><span>03</span><h3>Para compartilhar</h3><p>Porções, conversa e tempo bom ao redor da mesa.</p></div>
          </div>
          <a className="button" href={whatsapp} target="_blank" rel="noreferrer">Pedir o cardápio</a>
        </div>
      </section>

      <section className="gallery" id="galeria">
        <div className="gallery-head"><p className="section-number">04 — ATMOSFERA</p><h2>Viva a<br /><em>Esquina 013.</em></h2></div>
        <div className="gallery-grid">
          <figure className="gallery-main"><Image src="/images/fachada-esquina013.png" alt="Entrada do Esquina 013 à noite" fill sizes="70vw" /></figure>
          <figure className="gallery-detail detail-one"><Image src="/images/fachada-esquina013.png" alt="Iluminação neon da fachada" fill sizes="30vw" /></figure>
          <figure className="gallery-detail detail-two"><Image src="/images/logo-esquina013.png" alt="Identidade visual Esquina 013" fill sizes="30vw" /></figure>
        </div>
      </section>

      <section className="contact" id="contato">
        <div className="contact-copy"><p className="section-number">05 — ENCONTRE A GENTE</p><h2>A próxima noite<br />começa <em>aqui.</em></h2></div>
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
