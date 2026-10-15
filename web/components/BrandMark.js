// A house outline in the brand's teal with an orange hearth, after the ROCCO storefront mark.
export default function BrandMark({ className = 'brand-mark' }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M6 22 24 7l18 15" stroke="#1d6a72" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 19v21h26V19" stroke="#1d6a72" strokeWidth="3.4" strokeLinejoin="round" />
      <path d="M19 40V27h10v13" stroke="#e2833b" strokeWidth="3.4" strokeLinejoin="round" />
      <path d="M33 12v-3" stroke="#e2833b" strokeWidth="3.4" strokeLinecap="round" />
    </svg>
  );
}
