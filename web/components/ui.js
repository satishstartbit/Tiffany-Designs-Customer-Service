import Link from 'next/link';
import { ArrowLeft, ChevronLeft, ChevronRight, CircleAlert, Inbox } from 'lucide-react';
import { toneOf } from '@/lib/tones.js';

export function PageHeader({ eyebrow, title, description, actions, back }) {
  return (
    <>
      {back && (
        <Link className="back-link" href={back.href}>
          <ArrowLeft aria-hidden="true" /> {back.label}
        </Link>
      )}
      <header className="page-head">
        <div>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="filters-actions">{actions}</div>}
      </header>
    </>
  );
}

export function Card({ title, action, children, flush = false, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="card-head">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {flush ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

export function Badge({ tone = 'grey', children }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export function Status({ value, fallback = 'Not set' }) {
  return <Badge tone={value ? toneOf(value) : 'grey'}>{value || fallback}</Badge>;
}

export function Stat({ icon: Icon, label, value, hint, href }) {
  const body = (
    <>
      <span className="stat-icon">{Icon && <Icon aria-hidden="true" />}</span>
      <span>
        <span className="stat-label">{label}</span>
        <span className="stat-value" style={{ display: 'block' }}>{value}</span>
        {hint && <span className="stat-hint" style={{ display: 'block' }}>{hint}</span>}
      </span>
    </>
  );
  return href ? <Link className="card stat" href={href}>{body}</Link> : <div className="card stat">{body}</div>;
}

export function Empty({ icon: Icon = Inbox, title, children }) {
  return (
    <div className="empty">
      <Icon aria-hidden="true" />
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

export function Problem({ title = 'The data could not be loaded', message }) {
  return (
    <div className="problem" role="alert">
      <CircleAlert aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <div className="small" style={{ marginTop: 4 }}>{message}</div>
      </div>
    </div>
  );
}

// Label and value pairs; empty values show a dash.
export function Fields({ items, one = false }) {
  return (
    <dl className={one ? 'fields one' : 'fields'}>
      {items.filter(Boolean).map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value === null || value === undefined || value === '' ? '—' : value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Keeps the current filters when moving between pages.
export function Pagination({ basePath, params, page, hasMore, shown }) {
  const href = (target) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    if (target > 1) query.set('page', String(target));
    else query.delete('page');
    const text = query.toString();
    return text ? `${basePath}?${text}` : basePath;
  };
  if (page === 1 && !hasMore) return null;
  return (
    <div className="pagination">
      <span>Page {page} · {shown} shown</span>
      <nav aria-label="Pages">
        <Link className="btn btn-outline" href={href(page - 1)} aria-disabled={page <= 1}>
          <ChevronLeft aria-hidden="true" /> Previous
        </Link>
        <Link className="btn btn-outline" href={href(page + 1)} aria-disabled={!hasMore}>
          Next <ChevronRight aria-hidden="true" />
        </Link>
      </nav>
    </div>
  );
}

// A GET form: the page reads the filters from its address, so results can be shared and reloaded.
export function Filters({ action, search, selects = [], params }) {
  const active = Object.entries(params).some(([k, v]) => v && k !== 'page');
  return (
    <form className="card filters" action={action} role="search">
      {search && (
        <div className="field grow">
          <label htmlFor="filter-q">Search</label>
          <input id="filter-q" className="input" type="search" name="q" defaultValue={params.q || ''} placeholder={search} />
        </div>
      )}
      {selects.map((s) => (
        <div className="field" key={s.name}>
          <label htmlFor={`filter-${s.name}`}>{s.label}</label>
          <select id={`filter-${s.name}`} className="select" name={s.name} defaultValue={params[s.name] || ''}>
            <option value="">{s.all || 'All'}</option>
            {s.options.map((o) => {
              const [value, text] = Array.isArray(o) ? o : [o, o];
              return <option key={value} value={value}>{text}</option>;
            })}
          </select>
        </div>
      ))}
      <div className="filters-actions">
        <button className="btn" type="submit">Apply</button>
        {active && <Link className="btn btn-outline" href={action}>Clear</Link>}
      </div>
    </form>
  );
}

export function Tabs({ items, current }) {
  return (
    <nav className="tabs" aria-label="Views">
      {items.map((t) => (
        <Link key={t.href} href={t.href} aria-current={t.key === current ? 'page' : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}

// Search params arrive as strings or arrays; the console uses the first value of each.
export function readParams(searchParams, names) {
  return Object.fromEntries(names.map((n) => {
    const value = searchParams?.[n];
    return [n, Array.isArray(value) ? value[0] : value || ''];
  }));
}
