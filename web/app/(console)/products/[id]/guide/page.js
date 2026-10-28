import { notFound } from 'next/navigation';
import { PageHeader, Problem } from '@/components/ui.js';
import { loadAdmin } from '@/lib/api.js';
import GuideForm from './GuideForm.js';

export const metadata = { title: 'Product guide' };

export default async function ProductGuidePage({ params }) {
  const { id } = await params;
  const { data, error } = await loadAdmin(`products/${encodeURIComponent(id)}/guide`);
  if (error) return <Problem message={error} />;
  if (!data) notFound();

  return (
    <>
      <PageHeader
        back={{ href: `/products/${id}`, label: 'Back to the product' }}
        eyebrow={`${data.guide ? 'Edit' : 'Add'} product guide · ${data.product.code}`}
        title={data.product.name}
        description="Saved straight to Salesforce and noted in the guide's history with your name. The voice agent uses the guide once its status is Published."
      />
      <GuideForm productId={data.product.id} guide={data.guide} form={data.form} />
    </>
  );
}
