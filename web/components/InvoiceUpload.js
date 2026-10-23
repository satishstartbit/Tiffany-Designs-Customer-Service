'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleCheck, FileText, ImageUp, LoaderCircle, Receipt, RefreshCw, TriangleAlert, Upload } from 'lucide-react';

const ENDPOINT = '/api/invoice';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 2000;
const SENT_AS_IS = ['image/jpeg', 'image/png', 'image/webp'];
const DONE_TITLES = { matched: 'Invoice received and matched', received: 'Invoice received', not_found: 'Order not found' };

// Phone photos are large: an image is scaled down and sent as JPEG, which keeps the text readable and the upload small.
async function prepare(file) {
  if (file.type === 'application/pdf') {
    if (file.size > MAX_BYTES) throw new Error('This PDF is larger than 4 MB. Please upload a screenshot of the invoice instead.');
    return { blob: file, type: 'application/pdf' };
  }
  if (!file.type.startsWith('image/')) throw new Error('Please choose a photo, a screenshot or a PDF of the invoice.');

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    if (SENT_AS_IS.includes(file.type) && file.size <= MAX_BYTES) return { blob: file, type: file.type };
    throw new Error('This picture could not be opened. Please take a screenshot of the invoice and upload that.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const quality of [0.85, 0.7, 0.55]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_BYTES) return { blob, type: 'image/jpeg' };
  }
  throw new Error('This picture is too large. Please upload a screenshot of the invoice instead.');
}

// The customer's side of the invoice upload: choose a photo, screenshot or PDF, send it, and say what happened. The
// server reads the invoice and finds the customer and the order from it; this page only shows the answer's message.
export default function InvoiceUpload() {
  const input = useRef(null);
  const [available, setAvailable] = useState(true);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [phase, setPhase] = useState('choosing');
  const [result, setResult] = useState(null);
  const [problem, setProblem] = useState('');

  // Also wakes the server while the customer picks the file.
  useEffect(() => {
    let active = true;
    fetch(ENDPOINT, { cache: 'no-store' })
      .then((res) => active && res.status === 503 && setAvailable(false))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);

  function choose(event) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setProblem('');
    setFile(chosen);
    setPreview(chosen.type.startsWith('image/') ? URL.createObjectURL(chosen) : null);
  }

  async function send() {
    if (!file || phase === 'sending') return;
    setProblem('');
    setPhase('sending');
    try {
      const { blob, type } = await prepare(file);
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': type }, body: blob });
      const answer = await res.json().catch(() => ({}));
      if (res.ok) {
        setResult(answer);
        setPhase('done');
        return;
      }
      setProblem(answer.message || 'Something went wrong. Please try again in a minute.');
    } catch (err) {
      setProblem(err instanceof TypeError ? 'Your connection dropped. Please check it and try again.' : err.message);
    }
    setPhase('choosing');
  }

  function startOver() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setPhase('choosing');
  }

  if (!available) {
    return (
      <div className="upload-card upload-problem" role="alert">
        <TriangleAlert aria-hidden="true" />
        <p>Invoice upload is not available right now. Please try again later, or call Tiffany Designs customer care.</p>
      </div>
    );
  }

  if (phase === 'done') {
    const found = result?.status !== 'not_found';
    return (
      <div className={`upload-card ${found ? 'upload-done' : 'upload-problem'}`} role="status">
        {found ? <CircleCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        <h2>{DONE_TITLES[result?.status] || DONE_TITLES.received}</h2>
        <p>{result?.message}</p>
        {result?.invoice_number && <p className="small muted">Invoice number read: {result.invoice_number}</p>}
        <button className="btn btn-outline" type="button" onClick={startOver}><RefreshCw aria-hidden="true" /> Upload another invoice</button>
      </div>
    );
  }

  const sending = phase === 'sending';
  return (
    <div className="upload-card">
      <input ref={input} className="sr-only" id="invoice-file" type="file" accept="image/*,application/pdf" onChange={choose} disabled={sending} />
      <label className={`dropzone${file ? ' has-file' : ''}`} htmlFor="invoice-file" aria-disabled={sending}>
        {file && preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="The invoice you chose" />
        ) : file ? (
          <span className="dropzone-file"><FileText aria-hidden="true" /> {file.name}</span>
        ) : (
          <>
            <ImageUp aria-hidden="true" />
            <strong>Choose a photo, screenshot or PDF</strong>
            <span>The whole invoice, with the invoice number and order id readable</span>
          </>
        )}
      </label>

      {problem && <p className="upload-error" role="alert"><TriangleAlert aria-hidden="true" /> {problem}</p>}

      <div className="upload-actions">
        <button className="btn btn-maroon" type="button" onClick={send} disabled={!file || sending} aria-busy={sending}>
          {sending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Upload aria-hidden="true" />}
          {sending ? 'Reading your invoice' : 'Upload invoice'}
        </button>
        {file && !sending && (
          <button className="btn btn-outline" type="button" onClick={() => input.current?.click()}>
            <Receipt aria-hidden="true" /> Choose another
          </button>
        )}
      </div>
      {sending && <p className="small muted" role="status">This can take up to a minute. Please keep this page open.</p>}
    </div>
  );
}
