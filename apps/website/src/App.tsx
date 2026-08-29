import { useState, type ReactNode } from 'react';

type IconName =
  | 'arrow-right'
  | 'arrow-up-right'
  | 'building'
  | 'check'
  | 'github'
  | 'layers'
  | 'ledger'
  | 'lock'
  | 'menu'
  | 'plug'
  | 'shield'
  | 'users'
  | 'x';

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'arrow-right':
      return <svg {...common}><path d="M4 12h15" /><path d="m13 6 6 6-6 6" /></svg>;
    case 'arrow-up-right':
      return <svg {...common}><path d="M5 19 19 5" /><path d="M9 5h10v10" /></svg>;
    case 'building':
      return <svg {...common}><path d="M4 21h16" /><path d="M6 21V5l6-2 6 2v16" /><path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1" /></svg>;
    case 'check':
      return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case 'github':
      return <svg {...common}><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.5 5.5 0 0 0 19.3 4 5.1 5.1 0 0 0 19.2 1S18 0.6 15 2.6a13.4 13.4 0 0 0-6 0C6 0.6 4.8 1 4.8 1A5.1 5.1 0 0 0 4.7 4 5.5 5.5 0 0 0 3.2 7.5c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 9 18v4" /><path d="M9 18c-4.5 2-5-2-7-2" /></svg>;
    case 'layers':
      return <svg {...common}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></svg>;
    case 'ledger':
      return <svg {...common}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 11h8M8 15h4" /><path d="M16 17h.01" /></svg>;
    case 'lock':
      return <svg {...common}><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 14v3" /></svg>;
    case 'menu':
      return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
    case 'plug':
      return <svg {...common}><path d="m8 12 8-8" /><path d="m6 14 4 4" /><path d="M4 20 8 16" /><path d="m15 9 3 3" /><path d="m12 12 3 3" /><path d="M15 15c2.5 2.5 5 1 6 0" /></svg>;
    case 'shield':
      return <svg {...common}><path d="M12 3 20 6v5c0 5-3.3 8.3-8 10-4.7-1.7-8-5-8-10V6l8-3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></svg>;
    case 'users':
      return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></svg>;
    case 'x':
      return <svg {...common}><path d="M6 6l12 12M18 6 6 18" /></svg>;
  }
}

function Button({
  children,
  href,
  variant = 'primary',
  external = false,
  onClick,
}: {
  children: ReactNode;
  href: string;
  variant?: 'primary' | 'quiet' | 'outline';
  external?: boolean;
  onClick?: () => void;
}) {
  return (
    <a
      className={`button button-${variant}`}
      href={href}
      onClick={onClick}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
    >
      <span>{children}</span>
      <Icon name={external ? 'arrow-up-right' : 'arrow-right'} size={17} />
    </a>
  );
}

function SectionHeading({
  eyebrow,
  title,
  children,
  align = 'left',
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  align?: 'left' | 'center';
}) {
  return (
    <div className={`section-heading section-heading-${align}`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {children ? <p className="section-intro">{children}</p> : null}
    </div>
  );
}

function ProductPreview() {
  return (
    <div className="product-preview" aria-label="OpenEstate product preview">
      <div className="preview-chrome">
        <div className="preview-dots" aria-hidden="true"><span /><span /><span /></div>
        <span className="preview-url">app.openestate.local / dashboard</span>
        <span className="preview-secure"><Icon name="lock" size={12} /> secure</span>
      </div>
      <div className="preview-body">
        <aside className="preview-sidebar">
          <div className="preview-symbol">OE</div>
          <div className="preview-side-lines"><i /><i /><i /><i /><i /></div>
          <div className="preview-side-bottom"><i /><i /></div>
        </aside>
        <div className="preview-main">
          <div className="preview-topline">
            <div><span className="preview-muted">Demo Realty /</span> <strong>Overview</strong></div>
            <span className="preview-status"><b /> all systems operational</span>
          </div>
          <div className="preview-metrics">
            <div><span>Open inquiries</span><strong>184</strong><em>+12.4%</em></div>
            <div><span>Active inventory</span><strong>426</strong><em className="neutral">38 booked</em></div>
            <div><span>Receivables</span><strong>₹8.4Cr</strong><em>ledger derived</em></div>
          </div>
          <div className="preview-content-grid">
            <div className="preview-panel preview-funnel">
              <div className="panel-head"><strong>Sales funnel</strong><span>Last 30 days</span></div>
              <div className="funnel-row"><span>New inquiries</span><b style={{ width: '92%' }}>184</b></div>
              <div className="funnel-row"><span>Site visits</span><b style={{ width: '66%' }}>112</b></div>
              <div className="funnel-row"><span>Negotiation</span><b style={{ width: '42%' }}>61</b></div>
              <div className="funnel-row"><span>Booked</span><b className="orange" style={{ width: '22%' }}>38</b></div>
            </div>
            <div className="preview-panel preview-activity">
              <div className="panel-head"><strong>Recent activity</strong><span>View all</span></div>
              <div className="activity-item"><span className="activity-icon teal"><Icon name="users" size={13} /></span><div><strong>Priya assigned</strong><small>Inquiry #1048 · 2m ago</small></div></div>
              <div className="activity-item"><span className="activity-icon orange"><Icon name="ledger" size={13} /></span><div><strong>Receipt posted</strong><small>₹2,50,000 · 18m ago</small></div></div>
              <div className="activity-item"><span className="activity-icon blue"><Icon name="building" size={13} /></span><div><strong>Unit reserved</strong><small>Tower B / 1204 · 1h ago</small></div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const features: Array<{ icon: IconName; title: string; body: string; tone: string }> = [
  { icon: 'users', title: 'One funnel, end to end', body: 'Capture inquiries, assign work fairly, schedule follow-ups, and see the full story before a deal goes cold.', tone: 'teal' },
  { icon: 'building', title: 'Inventory with context', body: 'Projects, towers, floors, and units—or plotted/farmland inventory priced per acre—with rates and status changes your sales team can actually navigate.', tone: 'blue' },
  { icon: 'ledger', title: 'Ledger, not mutation', body: 'Receipts, installments, GST, TDS, interest, and corrections stay auditable and append-only.', tone: 'orange' },
  { icon: 'shield', title: 'Tenant boundaries that hold', body: 'PostgreSQL row-level security and application guards keep companies from crossing the line.', tone: 'teal' },
  { icon: 'layers', title: 'Portals included', body: 'Give customers and brokers a clear view of bookings, documents, statements, tickets, and commissions.', tone: 'blue' },
  { icon: 'plug', title: 'Extend without a fork', body: 'Plugins, webhooks, custom fields, and configurable terminology keep the core adaptable.', tone: 'orange' },
];

const installCommand = `sudo git clone https://github.com/AshishGTH/openestate.git /opt/openestate-src
cd /opt/openestate-src/deploy/native
sudo ./install-native.sh --server-name crm.yourcompany.com`;

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="container nav-bar">
          <a className="brand-link" href="#top" aria-label="OpenEstate by The IT Guys home" onClick={closeMenu}>
            <img src="/brand/logo-reversed.svg" alt="OpenEstate by The IT Guys" />
          </a>
          <nav className={`desktop-nav ${menuOpen ? 'nav-open' : ''}`} aria-label="Primary navigation">
            <a href="#capabilities" onClick={closeMenu}>Capabilities</a>
            <a href="#workflow" onClick={closeMenu}>How it works</a>
            <a href="#security" onClick={closeMenu}>Security</a>
            <a href="#install" onClick={closeMenu}>Install</a>
          </nav>
          <div className="nav-actions">
            <a className="nav-github" href="https://github.com/AshishGTH/openestate" target="_blank" rel="noreferrer"><Icon name="github" size={18} /><span>GitHub</span></a>
            <Button href="#demo" variant="outline" onClick={closeMenu}>Request a demo</Button>
            <button className="menu-toggle" type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <Icon name={menuOpen ? 'x' : 'menu'} size={22} />
            </button>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="hero-section" id="top">
          <div className="hero-grid" aria-hidden="true" />
          <div className="container hero-layout">
            <div className="hero-copy">
              <p className="eyebrow eyebrow-light"><span className="live-dot" /> Open-source CRM for property teams</p>
              <h1>Property sales should not live in <em>five disconnected tools.</em></h1>
              <p className="hero-lede">OpenEstate by The IT Guys brings pre-sales, inventory, post-sales finance, and customer portals into one self-hosted system you can inspect, adapt, and own.</p>
              <div className="hero-actions">
                <Button href="#install">Install OpenEstate</Button>
                <Button href="#demo" variant="quiet">Request a demo</Button>
              </div>
              <div className="hero-proof"><span>AGPL-3.0</span><i /> <span>PostgreSQL + Redis</span><i /> <span>Built for India</span></div>
            </div>
            <ProductPreview />
          </div>
          <a className="scroll-cue" href="#capabilities"><span>See the system</span><Icon name="arrow-right" size={16} /></a>
        </section>

        <section className="signal-band" aria-label="OpenEstate principles">
          <div className="container signal-grid">
            <div><span>01</span><strong>Your server</strong><small>No mandatory SaaS dependency</small></div>
            <div><span>02</span><strong>One source of truth</strong><small>Every team sees the same record</small></div>
            <div><span>03</span><strong>Built to adapt</strong><small>Plugins instead of a forked core</small></div>
            <div><span>04</span><strong>Auditable by design</strong><small>Financial records stay append-only</small></div>
          </div>
        </section>

        <section className="intro-section section-pad">
          <div className="container intro-layout">
            <SectionHeading eyebrow="The problem" title="The handoffs are where revenue gets lost.">
              A lead in one system. A unit in another. A payment spreadsheet no one trusts. OpenEstate gives the entire operation a shared, durable record—from first inquiry to final receipt.
            </SectionHeading>
            <div className="quote-card">
              <span className="quote-mark">“</span>
              <p>Software should make the work clearer, not turn your business into a dependency on someone else’s roadmap.</p>
              <div className="quote-rule" />
              <small>OpenEstate design principle</small>
            </div>
          </div>
        </section>

        <section className="capabilities-section section-pad" id="capabilities">
          <div className="container">
            <SectionHeading eyebrow="Capabilities" title="The operating layer your sales team has been assembling by hand." />
            <div className="feature-grid">
              {features.map((feature) => (
                <article className="feature-card" key={feature.title}>
                  <div className={`feature-icon feature-icon-${feature.tone}`}><Icon name={feature.icon} size={22} /></div>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                  <span className="feature-index">{String(features.indexOf(feature) + 1).padStart(2, '0')}</span>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="workflow-section section-pad" id="workflow">
          <div className="container workflow-layout">
            <SectionHeading eyebrow="How it works" title="A clear path from first conversation to closed ledger.">
              No black boxes. No magic handoffs. The system follows the way property teams actually work—and leaves a useful trail behind.
            </SectionHeading>
            <div className="workflow-list">
              <article className="workflow-step"><span>01</span><div><h3>Capture & assign</h3><p>Bring inquiries in through the API or import, match duplicates, and distribute work with a fair assignment pool.</p></div><Icon name="arrow-up-right" size={19} /></article>
              <article className="workflow-step"><span>02</span><div><h3>Qualify & follow up</h3><p>Keep notes, next actions, site visits, and escalation in the same timeline—not in someone’s memory.</p></div><Icon name="arrow-up-right" size={19} /></article>
              <article className="workflow-step"><span>03</span><div><h3>Book & collect</h3><p>Reserve inventory, snapshot commercial terms, generate a payment plan, and post receipts to the ledger.</p></div><Icon name="arrow-up-right" size={19} /></article>
              <article className="workflow-step"><span>04</span><div><h3>Keep the relationship</h3><p>Let customers and brokers see the documents, statements, tickets, and commissions that matter to them.</p></div><Icon name="arrow-up-right" size={19} /></article>
            </div>
          </div>
        </section>

        <section className="ledger-section section-pad">
          <div className="container ledger-layout">
            <div className="ledger-copy">
              <p className="eyebrow">Financial core</p>
              <h2>Balances you can explain six months later.</h2>
              <p>OpenEstate treats financial records as a ledger, not a mutable status field. A correction is a reversal. A balance is the sum of entries. That makes receipts, refunds, GST, TDS, interest, and audits easier to trust.</p>
              <a className="text-link" href="https://github.com/AshishGTH/openestate#architecture" target="_blank" rel="noreferrer">Read the architecture <Icon name="arrow-up-right" size={16} /></a>
            </div>
            <div className="ledger-card" aria-label="Example append-only ledger">
              <div className="ledger-card-head"><div><span className="small-label">Booking / OE-24018</span><strong>Ledger activity</strong></div><span className="ledger-badge"><Icon name="check" size={13} /> balanced</span></div>
              <div className="ledger-balance"><span>Current balance</span><strong>₹12,10,000</strong><small>derived from 7 entries</small></div>
              <div className="ledger-entries">
                <div><span className="entry-date">04 APR</span><span><strong>Booking charge</strong><small>Unit B-1204 · debit</small></span><b>+ ₹15,00,000</b></div>
                <div><span className="entry-date">04 APR</span><span><strong>Receipt posted</strong><small>RC-000184 · credit</small></span><b className="credit">− ₹2,50,000</b></div>
                <div><span className="entry-date">05 APR</span><span><strong>GST split</strong><small>CGST + SGST · debit</small></span><b>+ ₹1,80,000</b></div>
                <div><span className="entry-date">06 APR</span><span><strong>Correction reversal</strong><small>REF-000021 · credit</small></span><b className="credit">− ₹2,20,000</b></div>
              </div>
              <div className="ledger-footer"><Icon name="lock" size={14} /> Immutable financial rows</div>
            </div>
          </div>
        </section>

        <section className="security-section section-pad" id="security">
          <div className="container security-layout">
            <div className="security-stamp"><Icon name="shield" size={32} /><span>Designed<br />for control</span></div>
            <div className="security-copy">
              <SectionHeading eyebrow="Security & ownership" title="Self-hosted is a product decision, not a checkbox.">
                Run OpenEstate on infrastructure you control. PostgreSQL row-level security, tenant-aware data access, strong authentication, audit logs, and local file storage are part of the foundation.
              </SectionHeading>
              <div className="security-notes"><span><Icon name="check" size={15} /> Tenant isolation at the database layer</span><span><Icon name="check" size={15} /> Short-lived access + rotating refresh tokens</span><span><Icon name="check" size={15} /> Local-first storage with an S3-compatible option</span></div>
            </div>
          </div>
        </section>

        <section className="architecture-section section-pad">
          <div className="container">
            <div className="architecture-head"><SectionHeading eyebrow="One core, many verticals" title="Adapt the vocabulary without rewriting the product." /><p>Real estate is the first vertical. The architecture keeps the core extensible so the same operating patterns can serve other configurable domains.</p></div>
            <div className="architecture-map" aria-label="OpenEstate architecture map">
              <div className="map-root"><span className="map-kicker">Core</span><strong>OpenEstate</strong><small>Self-hosted CRM</small></div>
              <div className="map-branch branch-one"><span>Pre-sales</span><small>inquiries · follow-ups</small></div>
              <div className="map-branch branch-two"><span>Post-sales</span><small>ledger · receipts</small></div>
              <div className="map-branch branch-three"><span>Portals</span><small>customer · broker</small></div>
              <div className="map-branch branch-four"><span>Plugins</span><small>messaging · webhooks</small></div>
              <div className="map-line line-one" /><div className="map-line line-two" /><div className="map-line line-three" /><div className="map-line line-four" />
            </div>
          </div>
        </section>

        <section className="install-section section-pad" id="install">
          <div className="container install-layout">
            <SectionHeading eyebrow="Start here" title="A production path you can understand.">
              Install on your own Ubuntu server with PostgreSQL, Redis, and nginx. The repository documents the setup, backups, upgrades, and first-login checklist.
            </SectionHeading>
            <div className="terminal-card">
              <div className="terminal-head"><span className="terminal-dots"><i /><i /><i /></span><span>openestate / deploy / native</span><span className="terminal-copy">bash</span></div>
              <pre><code>{installCommand}</code></pre>
              <div className="terminal-foot"><span><Icon name="check" size={14} /> ready for your server</span><a href="https://github.com/AshishGTH/openestate/blob/master/docs/docs/installation.md" target="_blank" rel="noreferrer">Read installation guide <Icon name="arrow-up-right" size={15} /></a></div>
            </div>
          </div>
        </section>

        <section className="demo-section section-pad" id="demo">
          <div className="container demo-card">
            <div><p className="eyebrow eyebrow-light">See OpenEstate in context</p><h2>Bring us the messy version of your sales process.</h2><p>Tell us where the handoffs break today. We’ll show you how the pieces fit together—and what is already ready to run.</p></div>
            <div className="demo-actions"><Button href="https://github.com/AshishGTH/openestate/issues/new?title=OpenEstate%20demo%20request" external>Request a demo</Button><a className="demo-secondary" href="https://github.com/AshishGTH/openestate" target="_blank" rel="noreferrer">Explore the repository <Icon name="arrow-up-right" size={17} /></a></div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container footer-grid">
          <div className="footer-brand"><img src="/brand/logo-reversed.svg" alt="OpenEstate by The IT Guys" /><p>Open-source property operations, kept on your terms.</p></div>
          <div className="footer-links"><div><span>Product</span><a href="#capabilities">Capabilities</a><a href="#workflow">How it works</a><a href="#install">Install</a></div><div><span>Project</span><a href="https://github.com/AshishGTH/openestate" target="_blank" rel="noreferrer">GitHub</a><a href="https://github.com/AshishGTH/openestate/blob/master/CONTRIBUTING.md" target="_blank" rel="noreferrer">Contribute</a><a href="https://github.com/AshishGTH/openestate/blob/master/LICENSE" target="_blank" rel="noreferrer">AGPL-3.0</a></div></div>
        </div>
        <div className="container footer-bottom"><span>© {new Date().getFullYear()} The IT Guys</span><span>Built in the open.</span></div>
      </footer>
    </div>
  );
}

export default App;
