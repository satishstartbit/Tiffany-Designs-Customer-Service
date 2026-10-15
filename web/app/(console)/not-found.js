import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { Card, Empty } from '@/components/ui.js';

export default function NotFound() {
  return (
    <Card>
      <Empty icon={SearchX} title="That record was not found">
        It may have been deleted in Salesforce. <Link className="btn btn-ghost" href="/">Back to the dashboard</Link>
      </Empty>
    </Card>
  );
}
