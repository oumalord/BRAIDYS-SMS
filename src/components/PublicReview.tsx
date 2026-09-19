import { useState } from 'react';
import { MessageSquare, Star } from 'lucide-react';
import { ReviewsApi } from '../lib/api';
import { Button, Card, Field, Input, Select, Textarea, toast } from './ui';

function PublicReview() {
  const salonId = new URLSearchParams(window.location.search).get('salonId') || '';
  const [form, setForm] = useState({ customerName: '', phone: '', serviceName: '', staffName: '', rating: 5, comment: '' });
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await ReviewsApi.createPublic({ ...form, salonId });
      setSubmitted(true);
    } catch (cause: any) {
      toast(cause?.message || 'Could not submit your review.', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (submitted) return <div className="min-h-screen bg-[#071a3d] flex items-center justify-center p-4"><Card className="w-full max-w-lg p-8 text-center"><MessageSquare className="mx-auto text-[#0071e3]" size={36} aria-hidden="true" /><h1 className="text-2xl font-semibold mt-4">Thank you for your feedback</h1><p className="text-sm text-[#6E6E73] mt-2">Your review has been sent to the salon team.</p></Card></div>;

  return <div className="min-h-screen bg-[#071a3d] flex items-center justify-center p-4"><Card className="w-full max-w-lg p-6 sm:p-8"><div className="text-center mb-6"><div className="mx-auto w-12 h-12 rounded-2xl bg-[#0071e3] text-white flex items-center justify-center"><MessageSquare size={24} aria-hidden="true" /></div><h1 className="text-2xl font-semibold mt-4">Share your experience</h1><p className="text-sm text-[#6E6E73] mt-1">Your feedback helps us improve our service.</p></div><form className="space-y-4" onSubmit={submit}><Field label="Your name" htmlFor="review-name"><Input id="review-name" required value={form.customerName} onChange={event => setForm(current => ({ ...current, customerName: event.target.value }))} /></Field><Field label="Phone number" htmlFor="review-phone"><Input id="review-phone" required type="tel" inputMode="tel" value={form.phone} onChange={event => setForm(current => ({ ...current, phone: event.target.value }))} placeholder="e.g. 0712345678" /></Field><Field label="Service received" htmlFor="review-service"><Input id="review-service" required value={form.serviceName} onChange={event => setForm(current => ({ ...current, serviceName: event.target.value }))} placeholder="e.g. Knotless Braids" /></Field><Field label="Staff member (optional)" htmlFor="review-staff"><Input id="review-staff" value={form.staffName} onChange={event => setForm(current => ({ ...current, staffName: event.target.value }))} /></Field><Field label="Rating" htmlFor="review-rating"><Select id="review-rating" value={form.rating} onChange={event => setForm(current => ({ ...current, rating: Number(event.target.value) }))}><option value={5}>5 stars - Excellent</option><option value={4}>4 stars - Good</option><option value={3}>3 stars - Average</option><option value={2}>2 stars - Needs improvement</option><option value={1}>1 star - Poor</option></Select></Field><div><label className="block text-sm font-medium mb-1" htmlFor="review-comment">Comments (optional)</label><Textarea id="review-comment" rows={5} value={form.comment} onChange={event => setForm(current => ({ ...current, comment: event.target.value }))} placeholder="Tell us about your visit" /></div><Button type="submit" className="w-full" disabled={saving}><Star size={16} aria-hidden="true" />{saving ? 'Sending...' : 'Submit review'}</Button></form></Card></div>;
}

export default PublicReview;
