import { Link } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui.jsx';

export default function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader title="Page not found" />
      <EmptyState icon="info" title="This page does not exist">
        <Link to="/overview">Go to the live overview</Link>
      </EmptyState>
    </div>
  );
}
