import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Star } from 'lucide-react';
import { ReviewsApi } from '../lib/api';
import { Badge, Card, EmptyState, LoadingState, Select, toast } from '../components/ui';
import type { Review } from '../types';

function stars(rating: number): string {
  const whole = Math.max(1, Math.min(5, Math.round(rating)));
  return `${'★'.repeat(whole)}${'☆'.repeat(5 - whole)}`;
}

function Reviews() {
  const [loading, setLoading] = useState(true);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [staffFilter, setStaffFilter] = useState('all');

  useEffect(() => {
    let active = true;
    ReviewsApi.list()
      .then(items => {
        if (active) setReviews(items);
      })
      .catch((cause: any) => {
        if (active) toast(cause?.message || 'Could not load reviews.', 'error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const staffOptions = useMemo(() => {
    const names = Array.from(new Set(reviews.map(item => item.staffName).filter(Boolean)));
    return names.sort((a, b) => a.localeCompare(b));
  }, [reviews]);

  const visible = useMemo(
    () => reviews
      .filter(item => staffFilter === 'all' || item.staffName === staffFilter)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
    [reviews, staffFilter],
  );

  const averageRating = useMemo(() => {
    if (!visible.length) return 0;
    return visible.reduce((sum, item) => sum + Number(item.rating || 0), 0) / visible.length;
  }, [visible]);

  const byScore = useMemo(() => {
    const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
    for (const item of visible) {
      const score = Math.max(1, Math.min(5, Number(item.rating || 0))) as 1 | 2 | 3 | 4 | 5;
      counts[score] += 1;
    }
    return counts;
  }, [visible]);

  if (loading) return <LoadingState label="Loading reviews..." />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><MessageSquare size={20} aria-hidden="true" />Client Reviews</h1>
          <p className="text-sm text-[#6E6E73]">See all completed-service feedback with the staff member who served each client.</p>
        </div>
        <div className="w-full sm:w-64">
          <Select aria-label="Filter reviews by staff" value={staffFilter} onChange={event => setStaffFilter(event.target.value)}>
            <option value="all">All staff</option>
            {staffOptions.map(name => <option key={name} value={name}>{name}</option>)}
          </Select>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <Card className="p-5">
          <p className="text-xs text-[#6E6E73]">Total reviews</p>
          <p className="text-2xl font-semibold">{visible.length}</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-[#6E6E73]">Average rating</p>
          <p className="text-2xl font-semibold">{averageRating ? averageRating.toFixed(1) : '0.0'}/5</p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-[#6E6E73]">Rating mix</p>
          <p className="text-sm text-[#1D1D1F]">5★ {byScore[5]} · 4★ {byScore[4]} · 3★ {byScore[3]} · 2★ {byScore[2]} · 1★ {byScore[1]}</p>
        </Card>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={MessageSquare} title="No reviews yet" description="Client feedback from completed services will appear here." />
      ) : (
        <div className="space-y-3">
          {visible.map(item => (
            <Card key={item.id} className="p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <p className="font-medium">{item.serviceName || 'Service'}</p>
                  <p className="text-xs text-[#6E6E73]">Client: {item.customerName || 'Customer'} · Staff: {item.staffName || 'Unassigned'}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[#d89b00] flex items-center gap-1"><Star size={14} aria-hidden="true" />{stars(item.rating)}</span>
                  <Badge tone="info">{new Date(item.createdAt).toLocaleDateString()}</Badge>
                </div>
              </div>
              {item.comment && <p className="text-sm text-[#1D1D1F] mt-2">{item.comment}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default Reviews;
