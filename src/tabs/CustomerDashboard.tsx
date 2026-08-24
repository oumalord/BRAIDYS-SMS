import { useEffect, useState } from 'react';
import { CalendarCheck, Clock3, Crown, History, MessageSquare, Star, Ticket } from 'lucide-react';
import { CustomerApi, MembershipsApi, ReviewsApi, fmtKES } from '../lib/api';
import { MpesaPayModal } from '../components/MpesaPay';
import { Badge, Button, Card, Field, Input, LoadingState, Modal, Select, Textarea, toast } from '../components/ui';
import type { Appointment, Customer, MembershipPlan, Review } from '../types';

interface DashboardState { customer: Customer; appointments: Appointment[]; queue: any[]; reviews: Review[]; membershipPurchases: any[]; }

function CustomerDashboard({ account, onBook }: { account: { email?: string; phone?: string }; onBook: () => void }) {
  const [identity, setIdentity] = useState({ query: account.email || account.phone || '' });
  const [data, setData] = useState<DashboardState | null>(null);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState<Appointment | null>(null);
  const [membership, setMembership] = useState<MembershipPlan | null>(null);
  const [reviewForm, setReviewForm] = useState({ rating: 5, comment: '', cleanliness: '5', friendliness: '5', wouldReturn: 'yes' });

  useEffect(() => { MembershipsApi.list().then(setPlans).catch(() => {}); }, []);

  useEffect(() => {
    if (!identity.query) return;
    let active = true;
    setLoading(true);
    CustomerApi.find(identity.query).then(result => {
      if (active) setData(result);
    }).catch((cause: any) => {
      if (active) toast(cause?.message || 'Customer profile not found.', 'error');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [account.email, account.phone]);

  const load = async () => {
    if (!identity.query.trim()) { toast('Enter a name, email or phone number.', 'error'); return; }
    setLoading(true);
    try { setData(await CustomerApi.find(identity.query)); }
    catch (cause: any) { toast(cause?.message || 'Customer profile not found.', 'error'); }
    finally { setLoading(false); }
  };

  const submitReview = async () => {
    if (!data || !reviewing) return;
    try {
      await ReviewsApi.create({ appointmentId: reviewing.id, customerId: data.customer.id, customerName: data.customer.name, staffId: reviewing.staffId, staffName: reviewing.staffName || '', serviceName: reviewing.serviceName, rating: reviewForm.rating, comment: reviewForm.comment, survey: { cleanliness: Number(reviewForm.cleanliness), friendliness: Number(reviewForm.friendliness), wouldReturn: reviewForm.wouldReturn === 'yes' } });
      toast('Thank you for your feedback.', 'success');
      setReviewing(null);
      await load();
    } catch (cause: any) { toast(cause?.message || 'Could not submit review.', 'error'); }
  };

  const startMembershipPayment = (plan: MembershipPlan) => setMembership(plan);
  const purchaseMembership = async (receipt: string) => {
    if (!data || !membership) return;
    try {
      await CustomerApi.membershipPurchase({ customerId: data.customer.id, planId: membership.id, mpesaReceiptNumber: receipt });
      toast(`${membership.name} membership activated.`, 'success');
      setMembership(null);
      await load();
    } catch (cause: any) { toast(cause?.message || 'Could not activate membership.', 'error'); }
  };

  if (loading) return <LoadingState label="Loading your customer dashboard..." />;
  if (!data) return (
    <div className="max-w-xl mx-auto py-8 space-y-6">
      <div><h1 className="text-2xl font-semibold tracking-tight">Customer Dashboard</h1><p className="text-sm text-[#6E6E73]">View your appointments, queue tickets, membership coins and feedback history.</p></div>
      <Card className="p-6 space-y-4">
        <Field label="Search your profile" htmlFor="customer-dashboard-search"><Input id="customer-dashboard-search" value={identity.query} onChange={event => setIdentity({ query: event.target.value })} placeholder="Search by name, email or phone" /></Field>
        <Button className="w-full" onClick={load}>Open my dashboard</Button>
      </Card>
    </div>
  );

  const reviewedAppointmentIds = new Set(data.reviews.map(review => review.appointmentId));
  const activeQueue = data.queue.find(item => item.status !== 'completed');
  const activeMembership = data.customer.membershipTier && data.customer.membershipTier !== 'none';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">Welcome, {data.customer.name}</h1><p className="text-sm text-[#6E6E73]">Your personal SafiGroom dashboard.</p></div><Button variant="secondary" onClick={() => setData(null)}>Switch profile</Button></div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-5"><Clock3 size={18} className="text-[#0071e3]" aria-hidden="true" /><p className="text-xs text-[#6E6E73] mt-3">Loyalty coins</p><p className="text-2xl font-semibold">{data.customer.loyaltyPoints}</p></Card>
        <Card className="p-5"><Crown size={18} className="text-[#d89b00]" aria-hidden="true" /><p className="text-xs text-[#6E6E73] mt-3">Membership</p><p className="font-semibold">{activeMembership ? data.customer.membershipTier : 'Not enrolled'}</p>{data.customer.membershipExpiry && <p className="text-xs text-[#6E6E73]">Until {new Date(data.customer.membershipExpiry).toLocaleDateString()}</p>}</Card>
        <Card className="p-5"><History size={18} className="text-[#0071e3]" aria-hidden="true" /><p className="text-xs text-[#6E6E73] mt-3">Visits</p><p className="text-2xl font-semibold">{data.customer.visits}</p></Card>
        <Card className="p-5"><Ticket size={18} className="text-[#0071e3]" aria-hidden="true" /><p className="text-xs text-[#6E6E73] mt-3">Current ticket</p><p className="font-semibold">{activeQueue?.ticketNumber || 'None'}</p></Card>
      </div>

      {activeQueue && <Card className="p-5 border-[#0071e3]/20 bg-[#0071e3]/5"><div className="flex items-center gap-3"><Ticket className="text-[#0071e3]" aria-hidden="true" /><div><p className="font-semibold">Queue ticket {activeQueue.ticketNumber || 'pending'}</p><p className="text-sm text-[#6E6E73]">{activeQueue.status === 'in-service' ? 'You have been called in.' : `Position ${activeQueue.position} · ${activeQueue.staffName || 'Employee to be assigned'}`}</p></div><Badge tone={activeQueue.status === 'in-service' ? 'warning' : 'info'}>{activeQueue.status}</Badge></div></Card>}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="p-5"><div className="flex items-center justify-between mb-4"><h2 className="font-semibold flex items-center gap-2"><CalendarCheck size={17} aria-hidden="true" />Appointments</h2><Button size="sm" onClick={onBook}>Book another</Button></div><div className="space-y-3">{data.appointments.slice(0, 8).map(appointment => <div key={appointment.id} className="border-b border-black/5 pb-3 last:border-0"><div className="flex justify-between gap-2"><div><p className="font-medium text-sm">{appointment.serviceName}</p><p className="text-xs text-[#6E6E73]">{appointment.date} at {appointment.time} · {appointment.staffName || 'Employee pending'}</p></div><Badge tone={appointment.status === 'completed' ? 'success' : 'info'}>{appointment.status}</Badge></div>{appointment.status === 'completed' && !reviewedAppointmentIds.has(appointment.id) && <Button size="sm" variant="secondary" className="mt-2" onClick={() => setReviewing(appointment)}><Star size={14} aria-hidden="true" />Review service</Button>}</div>)}{data.appointments.length === 0 && <p className="text-sm text-[#6E6E73]">No appointments yet.</p>}</div></Card>
        <Card className="p-5"><h2 className="font-semibold flex items-center gap-2 mb-4"><Crown size={17} aria-hidden="true" />Membership plans</h2>{activeMembership ? <p className="text-sm text-[#6E6E73]">You are currently enjoying your {data.customer.membershipTier} benefits.</p> : <div className="space-y-3">{plans.map(plan => <div key={plan.id} className="border-b border-black/5 pb-3 last:border-0 flex items-center justify-between gap-3"><div><p className="font-medium text-sm">{plan.name}</p><p className="text-xs text-[#6E6E73]">{fmtKES(plan.priceKES)} · {plan.discountPct}% off · {plan.durationDays} days</p></div><Button size="sm" onClick={() => startMembershipPayment(plan)}>Join & pay</Button></div>)}</div>}</Card>
      </div>

      <Card className="p-5"><h2 className="font-semibold flex items-center gap-2 mb-3"><MessageSquare size={17} aria-hidden="true" />Your feedback</h2>{data.reviews.length === 0 ? <p className="text-sm text-[#6E6E73]">Your completed-service reviews will appear here.</p> : <div className="space-y-2">{data.reviews.map(review => <div key={review.id} className="flex items-center justify-between border-b border-black/5 pb-2"><span className="text-sm">{review.serviceName}</span><span className="text-sm text-[#d89b00]">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</span></div>)}</div>}</Card>

      {reviewing && <Modal title={`Review ${reviewing.serviceName}`} onClose={() => setReviewing(null)} footer={<><Button variant="secondary" onClick={() => setReviewing(null)}>Cancel</Button><Button onClick={submitReview}>Submit feedback</Button></>}><div className="space-y-4"><Field label="Overall rating" htmlFor="review-rating"><Select id="review-rating" value={String(reviewForm.rating)} onChange={event => setReviewForm(current => ({ ...current, rating: Number(event.target.value) }))}><option value="5">5 - Excellent</option><option value="4">4 - Good</option><option value="3">3 - Okay</option><option value="2">2 - Needs improvement</option><option value="1">1 - Poor</option></Select></Field><Field label="Cleanliness" htmlFor="survey-cleanliness"><Select id="survey-cleanliness" value={reviewForm.cleanliness} onChange={event => setReviewForm(current => ({ ...current, cleanliness: event.target.value }))}><option value="5">5 - Excellent</option><option value="4">4 - Good</option><option value="3">3 - Okay</option><option value="2">2 - Needs improvement</option><option value="1">1 - Poor</option></Select></Field><Field label="Employee friendliness" htmlFor="survey-friendliness"><Select id="survey-friendliness" value={reviewForm.friendliness} onChange={event => setReviewForm(current => ({ ...current, friendliness: event.target.value }))}><option value="5">5 - Excellent</option><option value="4">4 - Good</option><option value="3">3 - Okay</option><option value="2">2 - Needs improvement</option><option value="1">1 - Poor</option></Select></Field><Field label="Would you return?" htmlFor="survey-return"><Select id="survey-return" value={reviewForm.wouldReturn} onChange={event => setReviewForm(current => ({ ...current, wouldReturn: event.target.value }))}><option value="yes">Yes</option><option value="no">No</option></Select></Field><Field label="Comments" htmlFor="review-comment"><Textarea id="review-comment" rows={4} value={reviewForm.comment} onChange={event => setReviewForm(current => ({ ...current, comment: event.target.value }))} placeholder="Tell us about your service..." /></Field></div></Modal>}
      {membership && <MpesaPayModal amountKES={membership.priceKES} purpose="membership" initialPhone={data.customer.phone} onClose={() => setMembership(null)} onSuccess={purchaseMembership} />}
    </div>
  );
}

export default CustomerDashboard;
