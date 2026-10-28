'use server';

import { redirect } from 'next/navigation';
import { sendAdmin } from '@/lib/api.js';

// A "use server" file may export only async functions, so the field list stays private.
const GUIDE_FIELDS = [
  'name', 'status', 'brand', 'productType', 'modelCode', 'version', 'setContents', 'totalParts', 'partsHaveNumberStickers',
  'dimensions', 'colourFinish', 'material', 'weightCapacity', 'recommendedAge', 'toolsNeeded', 'overview', 'partsList',
  'hardwareList', 'assemblySteps', 'hardwarePerStep', 'assemblyTips', 'deliveryCheckScript', 'agentRules', 'warranty',
  'brandWebsite', 'brandSupportEmail', 'brandSupportWhatsApp', 'brandSupportHours', 'assemblyVideoUrl', 'manualPdfUrl',
  'source', 'lastReviewedOn',
];

// Sends the whole form; the Node server adds the guide or saves only what changed, and notes it in the guide's history.
export async function saveGuide(productId, previous, formData) {
  const values = Object.fromEntries(GUIDE_FIELDS.map((name) => [name, String(formData.get(name) ?? '')]));
  values.partsHaveNumberStickers = formData.get('partsHaveNumberStickers') === 'true' ? 'true' : 'false';
  const { data, error, field } = await sendAdmin(`products/${encodeURIComponent(productId)}/guide`, { method: 'PUT', body: values });
  if (error) return { error, field, values };
  redirect(`/products/${encodeURIComponent(productId)}?guide=${data.created ? 'added' : data.changes.length}`);
}
