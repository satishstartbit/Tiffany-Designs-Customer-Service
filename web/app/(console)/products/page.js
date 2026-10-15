import Link from 'next/link';
import { Boxes, LayoutGrid } from 'lucide-react';
import { CategoryIcon } from '@/components/icons.js';
import { Empty, Filters, PageHeader, Problem, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { money } from '@/lib/format.js';

export const metadata = { title: 'Products' };

export default async function ProductsPage({ searchParams }) {
  const params = readParams(await searchParams, ['q', 'category']);
  const { data, error } = await loadAdmin('products', params);
  const categoryHref = (category) => {
    const query = new URLSearchParams(Object.entries({ q: params.q, category }).filter(([, v]) => v));
    return query.toString() ? `/products?${query}` : '/products';
  };

  return (
    <>
      <PageHeader
        eyebrow="Catalogue"
        title="Products"
        description="Active Tiffany Designs products with their list price from the standard price book. The voice agent quotes and orders from this list."
      />
      {error ? <Problem message={error} /> : (
        <>
          <div className="section-head"><h2>Shop by category</h2></div>
          <nav className="category-row" aria-label="Categories">
            <Link className="category-tile" href={categoryHref('')} aria-current={!params.category ? 'page' : undefined}>
              <LayoutGrid aria-hidden="true" /> All products
            </Link>
            {data.categories.map((c) => (
              <Link key={c} className="category-tile" href={categoryHref(c)} aria-current={params.category === c ? 'page' : undefined}>
                <CategoryIcon category={c} /> {c}
              </Link>
            ))}
          </nav>

          <Filters action="/products" search="Name or product code" params={params} />

          <div className="section-head">
            <h2>{params.category || 'All products'}</h2>
            <span className="muted small">{data.products.length} {data.products.length === 1 ? 'product' : 'products'}</span>
          </div>
          {data.products.length ? (
            <div className="product-grid">
              {data.products.map((p) => (
                <Link key={p.id} className="card product-card" href={`/products/${p.id}`}>
                  <div className="product-image">
                    {p.imageUrl
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={p.imageUrl} alt="" loading="lazy" />
                      : <CategoryIcon category={p.category} />}
                    {p.partCount > 0 && <span className="corner-badge">{p.partCount} parts</span>}
                  </div>
                  <div className="product-info">
                    <span className="product-name">{p.name}</span>
                    <span className="price">{money(p.price)}</span>
                    <span className="product-meta">
                      <span className="tag mono">{p.code}</span>
                      <span className="tag">{p.category}</span>
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="card"><Empty icon={Boxes} title="No products match">Try another name, code or category.</Empty></div>
          )}
        </>
      )}
    </>
  );
}
