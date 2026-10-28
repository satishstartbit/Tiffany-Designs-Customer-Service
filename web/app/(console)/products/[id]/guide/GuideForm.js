'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Save } from 'lucide-react';
import { Card, Problem } from '@/components/ui.js';
import { saveGuide } from './actions.js';

// One labelled control; shows the server's message under the field it is about.
function Field({ name, label, hint, error, children, wide = false }) {
  return (
    <div className={wide ? 'field wide' : 'field'}>
      <label htmlFor={`guide-${name}`}>{label}</label>
      {children}
      {error ? <span className="field-error" id={`guide-${name}-error`}>{error}</span> : hint && <span className="hint">{hint}</span>}
    </div>
  );
}

// Form values as text: a new guide starts as a draft, and an empty field is an empty string.
function startValues(guide) {
  if (!guide) return { status: 'Draft', partsHaveNumberStickers: 'false' };
  return Object.fromEntries(Object.entries(guide.values).map(([k, v]) => [k, v === null ? '' : String(v)]));
}

export default function GuideForm({ productId, guide, form }) {
  const [state, action, pending] = useActionState(saveGuide.bind(null, productId), null);
  // After a refused save the form keeps what was typed; React resets the fields to these values.
  const values = state?.values || startValues(guide);
  const { labels, options, maxLengths, required } = form;
  const errorFor = (name) => (state?.field === name ? state.error : null);
  const control = (name) => ({
    id: `guide-${name}`,
    name,
    defaultValue: values[name] ?? '',
    required: required.includes(name),
    maxLength: maxLengths[name],
    'aria-invalid': state?.field === name || undefined,
    'aria-describedby': state?.field === name ? `guide-${name}-error` : undefined,
  });
  const field = (name, input, { hint, wide } = {}) => (
    <Field name={name} label={labels[name]} hint={hint} wide={wide} error={errorFor(name)}>{input}</Field>
  );
  const text = (name, extra = {}) => <input className="input" type="text" autoComplete="off" {...control(name)} {...extra} />;
  const area = (name, rows = 8) => <textarea className="input textarea" rows={rows} {...control(name)} />;
  const select = (name, choices, emptyLabel) => (
    <select className="select" {...control(name)} maxLength={undefined}>
      {!required.includes(name) && <option value="">{emptyLabel}</option>}
      {choices.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );

  return (
    <form action={action} className="grid">
      {state?.error && <Problem title="Not saved" message={state.error} />}

      <div className="grid grid-2">
        <Card title="Guide">
          <div className="form-grid">
            {field('name', text('name'), { wide: true, hint: guide ? null : 'Left empty, it is named after the product.' })}
            {field('status', select('status', options.status, 'Not set'), { hint: 'Only a Published guide is used by the voice agent.' })}
            {field('version', text('version'))}
            {field('brand', text('brand'))}
            {field('productType', select('productType', options.productType, 'Not set'))}
            {field('modelCode', text('modelCode', { className: 'input mono' }))}
            {field('lastReviewedOn', <input className="input" type="date" {...control('lastReviewedOn')} maxLength={undefined} />)}
            {field('source', text('source'), { wide: true, hint: 'Where the information comes from, e.g. the manufacturer manual.' })}
          </div>
        </Card>

        <Card title="Specifications">
          <div className="form-grid">
            {field('setContents', text('setContents'), { wide: true, hint: 'What is in the box, e.g. 1 kitchen island: 16 numbered parts and a hardware pack.' })}
            {field('totalParts', <input className="input" type="number" min="0" step="any" {...control('totalParts')} maxLength={undefined} />)}
            <div className="field">
              <span className="hint" aria-hidden="true">&nbsp;</span>
              <label className="check" htmlFor="guide-partsHaveNumberStickers">
                <input
                  id="guide-partsHaveNumberStickers"
                  type="checkbox"
                  name="partsHaveNumberStickers"
                  value="true"
                  defaultChecked={values.partsHaveNumberStickers === 'true'}
                />
                {labels.partsHaveNumberStickers}
              </label>
            </div>
            {field('dimensions', text('dimensions'))}
            {field('colourFinish', text('colourFinish'))}
            {field('material', text('material'), { wide: true })}
            {field('weightCapacity', text('weightCapacity'))}
            {field('recommendedAge', <input className="input" type="number" min="0" step="1" {...control('recommendedAge')} maxLength={undefined} />)}
            {field('toolsNeeded', text('toolsNeeded'), { wide: true })}
          </div>
        </Card>
      </div>

      <Card title="Overview">
        {field('overview', area('overview', 6), { wide: true })}
      </Card>

      <Card title="Parts and hardware">
        <div className="form-grid">
          {field('partsList', area('partsList', 14), {
            hint: 'One part per line with its sticker number, quantity and part number, e.g. 1. Worktop x 1, part number KIS-WALKY-01. Use the part numbers of the spare parts below.',
          })}
          {field('hardwareList', area('hardwareList', 14), { hint: 'One item per line, e.g. A. Cam bolts, for joining panels.' })}
        </div>
      </Card>

      <Card title="Assembly">
        <div className="form-grid">
          {field('assemblySteps', area('assemblySteps', 14), { wide: true, hint: 'One numbered step per line.' })}
          {field('hardwarePerStep', area('hardwarePerStep', 10))}
          {field('assemblyTips', area('assemblyTips', 10))}
        </div>
      </Card>

      <Card title="For the voice agent">
        <div className="form-grid">
          {field('deliveryCheckScript', area('deliveryCheckScript', 6), { hint: 'What to check, one part at a time, when the order is delivered.' })}
          {field('agentRules', area('agentRules', 6), {
            hint: 'One rule per line, written as the agent does, e.g. For a fault in the power socket unit, the agent asks the customer to unplug the island.',
          })}
        </div>
      </Card>

      <Card title="Warranty and brand support">
        <div className="form-grid">
          {field('warranty', area('warranty', 4), { wide: true })}
          {field('brandWebsite', text('brandWebsite', { type: 'url', placeholder: 'https://' }))}
          {field('brandSupportEmail', text('brandSupportEmail', { type: 'email' }))}
          {field('brandSupportWhatsApp', text('brandSupportWhatsApp', { type: 'tel', inputMode: 'tel' }))}
          {field('brandSupportHours', text('brandSupportHours'))}
          {field('assemblyVideoUrl', text('assemblyVideoUrl', { type: 'url', placeholder: 'https://' }))}
          {field('manualPdfUrl', text('manualPdfUrl', { type: 'url', placeholder: 'https://' }))}
        </div>
      </Card>

      <div className="form-actions">
        <button className="btn" type="submit" disabled={pending}>
          <Save aria-hidden="true" /> {pending ? 'Saving…' : guide ? 'Save changes' : 'Add guide'}
        </button>
        <Link className="btn btn-outline" href={`/products/${productId}`}>Cancel</Link>
      </div>
    </form>
  );
}
