import { permanentRedirect } from 'next/navigation';

// The old public call page now lives on the customer care page.
export default function CallPage() {
  permanentRedirect('/support');
}
