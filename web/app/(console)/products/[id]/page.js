import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BookOpen, CircleCheck, Package, Pencil, Plus, Wrench } from 'lucide-react';
import { CategoryIcon } from '@/components/icons.js';
import { Badge, Card, Empty, Fields, PageHeader, Problem, Stat, Status, readParams } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import { date, money, number } from '@/lib/format.js';

export const metadata = { title: 'Product' };

// A guide text field as written, line breaks kept; nothing when it is empty.
function GuideText({ title, text }) {
  if (!text) return null;
  return <Card title={title}><p className="description">{text}</p></Card>;
}

const link = (url, label) => (url ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : null);

function ProductGuide({ productId, guide }) {
  const g = guide.values;
  return (
    <>
      <Card title="Specifications">
        <Fields items={[
          ['Brand', g.brand],
          ['Product type', g.productType],
          ['Set contents', g.setContents],
          ['Total parts', g.totalParts === null ? null : number(g.totalParts)],
          ['Number stickers on parts', g.partsHaveNumberStickers ? 'Yes' : 'No'],
          ['Dimensions', g.dimensions],
          ['Colour and finish', g.colourFinish],
          ['Material', g.material],
          ['Weight capacity', g.weightCapacity],
          ['Recommended age', g.recommendedAge === null ? null : `${number(g.recommendedAge)} years and up`],
          ['Tools needed', g.toolsNeeded],
          ['Model code', g.modelCode],
        ]}
        />
      </Card>
      <GuideText title="Overview" text={g.overview} />
      <div className="grid grid-2">
        <GuideText title="Parts list" text={g.partsList} />
        <GuideText title="Hardware list" text={g.hardwareList} />
      </div>
      <GuideText title="Assembly steps" text={g.assemblySteps} />
      <div className="grid grid-2">
        <GuideText title="Hardware per step" text={g.hardwarePerStep} />
        <GuideText title="Tips, safety and care" text={g.assemblyTips} />
      </div>
      <div className="grid grid-2">
        <GuideText title="Delivery check" text={g.deliveryCheckScript} />
        <GuideText title="Rules for the voice agent" text={g.agentRules} />
      </div>
      <GuideText title="Warranty" text={g.warranty} />
      <Card title="Brand support and sources">
        <Fields items={[
          ['Brand website', link(g.brandWebsite, g.brandWebsite)],
          ['Support email', g.brandSupportEmail],
          ['Support WhatsApp', g.brandSupportWhatsApp],
          ['Support hours', g.brandSupportHours],
          ['Assembly video', link(g.assemblyVideoUrl, 'Watch')],
          ['Manual (PDF)', link(g.manualPdfUrl, 'Open')],
          ['Source', g.source],
          ['Last reviewed', g.lastReviewedOn ? date(g.lastReviewedOn) : null],
          ['Last changed', `${date(guide.lastModified)}${guide.lastModifiedBy ? ` by ${guide.lastModifiedBy}` : ''}`],
        ]}
        />
      </Card>
      <p className="small">
        Changes are noted in the guide&apos;s history with your name. <Link href={`/products/${productId}/guide`}>Edit the guide</Link>.
      </p>
    </>
  );
}

export default async function ProductPage({ params, searchParams }) {
  const { id } = await params;
  const { guide: savedGuide } = readParams(await searchParams, ['guide']);
  const [{ data: p, error }, { data: guideData, error: guideError }] = await Promise.all([
    loadAdmin(`products/${encodeURIComponent(id)}`),
    loadAdmin(`products/${encodeURIComponent(id)}/guide`),
  ]);
  if (error) return <Problem message={error} />;
  if (!p) notFound();
  const guide = guideData?.guide || null;

  return (
    <>
      <PageHeader back={{ href: '/products', label: 'Products' }} eyebrow={p.category} title={p.name} />
      {savedGuide !== '' && (
        <div className="notice" role="status">
          <CircleCheck aria-hidden="true" />
          {savedGuide === 'added' ? 'The product guide was added to Salesforce.'
            : Number(savedGuide) > 0 ? `Saved ${savedGuide} ${Number(savedGuide) === 1 ? 'change' : 'changes'} to the product guide.` : 'Nothing was changed.'}
        </div>
      )}
      <div className="product-hero">
        <div className="product-image">
          {p.imageUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={p.imageUrl} alt={p.name} />
            : <CategoryIcon category={p.category} />}
        </div>
        <div>
          <div className="chips">
            <span className="tag mono">{p.code}</span>
            <Badge tone={p.active ? 'green' : 'grey'}>{p.active ? 'Active' : 'Inactive'}</Badge>
          </div>
          <div className="big-price">{money(p.price)}</div>
          <p className="description">{p.description || 'No description in Salesforce yet.'}</p>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <Stat icon={Package} label="Units ordered" value={number(p.unitsOrdered)} />
            <Stat icon={Package} label="Order lines" value={number(p.orderLines)} />
            <Stat icon={Wrench} label="Spare parts" value={number(p.parts.length)} />
          </div>
        </div>
      </div>

      <section className="section grid">
        <div className="section-head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <h2>Product guide</h2>
            {guide && <Status value={guide.values.status} />}
            {guide?.values.version && <span className="tag">Version {guide.values.version}</span>}
          </div>
          {guideData && (
            <Link className="btn" href={`/products/${p.id}/guide`}>
              {guide ? <><Pencil aria-hidden="true" /> Edit guide</> : <><Plus aria-hidden="true" /> Add guide</>}
            </Link>
          )}
        </div>
        {guideError && <Problem title="The product guide could not be loaded" message={guideError} />}
        {guide && <ProductGuide productId={p.id} guide={guide} />}
        {guideData && !guide && (
          <Card>
            <Empty icon={BookOpen} title="No product guide yet">
              Add the specifications, parts, hardware and assembly steps. The voice agent uses a published guide to check a damaged or missing part one part at a time.
            </Empty>
          </Card>
        )}
      </section>

      <div className="grid grid-2 section">
        <Card title="Spare parts" flush>
          {p.parts.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Part</th><th>Part number</th></tr></thead>
                <tbody>
                  {p.parts.map((part) => (
                    <tr key={part.id}><td>{part.name}</td><td className="mono">{part.partNumber || '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={Wrench} title="No parts listed">Parts are kept as Product Components in Salesforce.</Empty>}
        </Card>

        <Card title="Recent orders" flush>
          {p.recentOrders.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Order</th><th>Customer</th><th className="num">Qty</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {p.recentOrders.map((o) => (
                    <tr key={`${o.orderId}-${o.quantity}-${o.total}`}>
                      <td>
                        <Link className="row-link" href={`/orders/${o.orderId}`}>{o.erpOrderId || `#${o.orderNumber}`}</Link>
                        <span className="cell-sub">{date(o.orderDate)} · <Status value={o.status} /></span>
                      </td>
                      <td>{o.customerName || '—'}</td>
                      <td className="num">{o.quantity}</td>
                      <td className="num price">{money(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty icon={Package} title="Not ordered yet" />}
        </Card>
      </div>
    </>
  );
}
