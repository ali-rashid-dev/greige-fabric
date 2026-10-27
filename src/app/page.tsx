import { businessConfig } from "@/config/business";

export default function Home() {
  return (
    <main className="pos-shell">
      <header className="pos-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="brand-name">{businessConfig.name}</p>
            <p className="brand-caption">POINT OF SALE</p>
          </div>
        </div>
        <span className="currency-badge">{businessConfig.currency}</span>
      </header>

      <section className="welcome-panel" aria-labelledby="welcome-title">
        <div className="welcome-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="eyebrow">YOUR WORKSPACE</p>
        <h1 id="welcome-title">{businessConfig.productName}</h1>
        <p className="welcome-copy">
          Your point-of-sale workspace is ready. Build the tools your business
          needs here.
        </p>
        <p className="setup-note">
          Starter setup · Currency baseline: {businessConfig.currency}
        </p>
      </section>

      <footer className="pos-footer">
        <span>{businessConfig.name}</span>
        <span>Desktop workspace</span>
      </footer>
    </main>
  );
}
