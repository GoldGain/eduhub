import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabaseUntyped } from '@/lib/supabase/client';
import { Download, FileText, Loader2, Users, Share2, Lock, CreditCard, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  generateUniqueAIComment,
  drawTrendGraph,
  addSignaturesToPDF,
  drawReportHeader,
  drawStudentInfo,
  drawResultsTable,
  drawSummaryBox,
  drawDeviation,
  drawAchievements,
  drawAIComment,
  getPercentage,
  formatPosition,
  addStudentPhotoToPDF,
  type SchoolInfo,
  type SignatureInfo,
} from '@/lib/reportCardPdf';
import { getSchoolLevelBand } from '@/lib/grading';
import { computeBestPerSubject } from '@/lib/bestPerSubject';
import type { BestInSubject } from '@/lib/bestPerSubject';
import { loadSchoolBranding, resolveSchoolName } from '@/lib/schoolBranding';

declare global {
  interface Window {
    PaystackPop?: {
      setup: (options: Record<string, any>) => { openIframe: () => void };
    };
  }
}

function loadPaystackScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.PaystackPop) return resolve();
    const existing = document.querySelector('script[src="https://js.paystack.co/v1/inline.js"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Paystack.')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.paystack.co/v1/inline.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Paystack.'));
    document.body.appendChild(script);
  });
}

export default function ParentChildReportCard() {
  const { user, schoolData } = useAuth();
  const [children, setChildren] = useState<any[]>([]);
  const [selectedChild, setSelectedChild] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [terms, setTerms] = useState<any[]>([]);
  const [selectedTerm, setSelectedTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [schoolPayConfig, setSchoolPayConfig] = useState<any>(null);
  const [pdfPaid, setPdfPaid] = useState<Record<string, boolean>>({});
  const [paying, setPaying] = useState(false);
  const [schoolInfo, setSchoolInfo] = useState<SchoolInfo>({ name: '' });
  const [signatures, setSignatures] = useState<SignatureInfo>({});
  const [classBestList, setClassBestList] = useState<BestInSubject[]>([]);
  const [previousAvg, setPreviousAvg] = useState<number | null>(null);
  const [trendData, setTrendData] = useState<{ term: string; avg: number }[]>([]);
  const [totalStudents, setTotalStudents] = useState(0);

  useEffect(() => { fetchChildren(); }, [user?.id]);

  const fetchChildren = async () => {
    setLoading(true);
    const { data: links } = await supabaseUntyped
      .from('parent_student_links')
      .select('student_id')
      .eq('parent_id', user?.id);
    if (links && links.length > 0) {
      const ids = links.map((l: any) => l.student_id);
      const { data: students } = await supabaseUntyped
        .from('students')
        .select('*, classes(name, level, grade_level, curriculum, class_teacher_id)')
        .in('id', ids);
      setChildren(students || []);
      if (students && students.length > 0) {
        const firstChild = students[0] as any;
        setSelectedChild(firstChild);
        fetchTerms(firstChild.school_id);
        fetchSchoolPayConfig(firstChild.school_id);
        fetchSchoolInfo(firstChild.school_id);
        fetchSignatures(firstChild.school_id, firstChild.classes?.class_teacher_id);
        fetchTotalStudents(firstChild.class_id, firstChild.school_id);
      }
    }
    setLoading(false);
  };

  const fetchTotalStudents = async (classId: string, schoolId: string) => {
    const { count } = await supabaseUntyped
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('class_id', classId)
      .eq('school_id', schoolId);
    setTotalStudents(count || 0);
  };

  const fetchSchoolInfo = async (schoolId: string) => {
    try {
      const fallbackName = resolveSchoolName(schoolData?.name);
      const { data, found, error } = await loadSchoolBranding(
        supabaseUntyped,
        schoolId,
        fallbackName,
      );

      if (!found) console.error('Unable to load complete school branding:', error);
      setSchoolInfo(data);
      setSignatures(prev => ({
        ...prev,
        principal_signature_url: data.principal_signature_url,
      }));
    } catch (err) {
      console.error('Unable to load school branding:', err);
      setSchoolInfo(prev => ({
        ...prev,
        name: resolveSchoolName(prev.name, schoolData?.name || undefined),
      }));
    }
  };

  const fetchSignatures = async (schoolId: string, classTeacherId?: string) => {
    let principalSigUrl: string | null = null;
    try {
      const { data: schoolSig } = await supabaseUntyped
        .from('schools')
        .select('principal_signature_url')
        .eq('id', schoolId)
        .maybeSingle();
      principalSigUrl = schoolSig?.principal_signature_url || null;
    } catch {
      // Ignore if column doesn't exist
    }
    let teacherSigUrl: string | null = null;
    if (classTeacherId) {
      try {
        const { data: teacherSig } = await supabaseUntyped
          .from('teachers')
          .select('signature_url')
          .eq('id', classTeacherId)
          .maybeSingle();
        teacherSigUrl = teacherSig?.signature_url || null;
      } catch {
        // Ignore errors
      }
    }
    setSignatures(prev => ({
      ...prev,
      principal_signature_url: principalSigUrl,
      teacher_signature_url: teacherSigUrl,
    }));
  };

  const fetchSchoolPayConfig = async (schoolId: string) => {
    const { data: school } = await supabaseUntyped
      .from('schools')
      .select('parent_pay_enabled, view_results_fee, pdf_report_fee, reseller_id')
      .eq('id', schoolId)
      .maybeSingle();
    if (!school) return;
    let resellerPaystackKey: string | null = null;
    if (school.reseller_id) {
      const { data: reseller } = await supabaseUntyped
        .from('resellers')
        .select('paystack_public_key, parent_pay_enabled')
        .eq('id', school.reseller_id)
        .maybeSingle();
      if (reseller?.parent_pay_enabled && reseller?.paystack_public_key) {
        resellerPaystackKey = reseller.paystack_public_key;
      }
    }
    setSchoolPayConfig({
      parent_pay_enabled: school.parent_pay_enabled && !!resellerPaystackKey,
      view_results_fee: school.view_results_fee || 50,
      pdf_report_fee: school.pdf_report_fee || 50,
      reseller_id: school.reseller_id,
      reseller_paystack_public_key: resellerPaystackKey,
      school_id: schoolId,
    });
  };

  const checkPdfPaid = async (childId: string): Promise<boolean> => {
    if (pdfPaid[childId]) return true;
    const { data } = await supabaseUntyped
      .from('parent_payments')
      .select('id')
      .eq('parent_id', user?.id)
      .eq('student_id', childId)
      .eq('payment_type', 'pdf_report')
      .eq('status', 'success')
      .limit(1);
    const paid = !!(data && data.length > 0);
    if (paid) setPdfPaid(prev => ({ ...prev, [childId]: true }));
    return paid;
  };

  const fetchTerms = async (schoolId: string) => {
    const { data } = await supabaseUntyped
      .from('terms')
      .select('*')
      .eq('school_id', schoolId)
      .order('academic_year', { ascending: false });
    setTerms(data || []);
    if (data && data.length > 0) setSelectedTerm(data[0].id);
  };

  useEffect(() => {
    if (selectedChild && selectedTerm) {
      fetchResults();
      fetchTrendData();
    }
  }, [selectedChild, selectedTerm]);

  const fetchResults = async () => {
    if (!selectedChild || !selectedTerm) return;
    const { data } = await supabaseUntyped
      .from('results')
      .select('*, subjects(name)')
      .eq('student_id', selectedChild.id)
      .eq('term_id', selectedTerm);
    setResults(data || []);
    await fetchPreviousAvg();
    const { data: classResults } = await supabaseUntyped
      .from('results')
      .select('*, students(id, first_name, last_name), subjects(name)')
      .eq('class_id', selectedChild.class_id)
      .eq('term_id', selectedTerm);
    if (classResults && classResults.length > 0) {
      setClassBestList(computeBestPerSubject(classResults, selectedChild?.classes || {}));
    } else {
      setClassBestList([]);
    }
  };

  const fetchTrendData = async () => {
    if (!selectedChild) return;
    const { data: allResults } = await supabaseUntyped
      .from('results')
      .select('percentage, marks, out_of, term_id, terms(name, academic_year)')
      .eq('student_id', selectedChild.id)
      .order('terms(academic_year)', { ascending: true })
      .order('terms(name)', { ascending: true });
    if (!allResults) return;
    const termMap: Record<string, { term: string; total: number; count: number }> = {};
    allResults.forEach((r: any) => {
      const tname = r.terms?.name || '';
      const year = r.terms?.academic_year || '';
      const key = `${year}-${tname}`;
      const pct = r.percentage !== undefined && r.percentage !== null ? Number(r.percentage) : (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0);
      if (!termMap[key]) termMap[key] = { term: `${tname} ${year}`, total: 0, count: 0 };
      termMap[key].total += pct;
      termMap[key].count++;
    });
    setTrendData(Object.values(termMap).map(t => ({ term: t.term, avg: t.count > 0 ? t.total / t.count : 0 })));
  };

  const fetchPreviousAvg = async () => {
    if (!selectedChild || !selectedTerm || terms.length === 0) { setPreviousAvg(null); return; }
    const sortedTerms = [...terms].sort((a, b) => {
      if (a.academic_year !== b.academic_year) return Number(a.academic_year) - Number(b.academic_year);
      const termNum = (n: string) => n.includes('1') ? 1 : n.includes('2') ? 2 : 3;
      return termNum(a.name) - termNum(b.name);
    });
    const currentIdx = sortedTerms.findIndex(t => t.id === selectedTerm);
    if (currentIdx <= 0) { setPreviousAvg(null); return; }
    const prevTerm = sortedTerms[currentIdx - 1];
    const { data: prevResults } = await supabaseUntyped
      .from('results')
      .select('marks, out_of, percentage')
      .eq('student_id', selectedChild.id)
      .eq('term_id', prevTerm.id);
    if (!prevResults || prevResults.length === 0) { setPreviousAvg(null); return; }
    const totalPct = prevResults.reduce((s: number, r: any) => s + (r.percentage || (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0)), 0);
    setPreviousAvg(totalPct / prevResults.length);
  };

  const isPrimaryLevel = (classData: any): boolean => {
    const gl = classData?.grade_level ?? classData?.level;
    return Number(gl || 0) <= 6;
  };

  const classDataForGrading = selectedChild?.classes || {};
  const is844 = (classDataForGrading?.curriculum || 'CBE') === '844';
  const band = getSchoolLevelBand(classDataForGrading);
  const isPrimary = band === 'primary';

  const doGeneratePDF = async () => {
    if (!results.length) { toast.error('No results found for this term'); return; }
    setGenerating(true);
    try {
      const { jsPDF } = await import('jspdf');
      const doc = new jsPDF();
      const term = terms.find(t => t.id === selectedTerm);
      const avgPercentage = results.length
        ? results.reduce((s, r) => s + getPercentage(r), 0) / results.length
        : 0;
      const totalPoints = is844
        ? results.reduce((s, r) => {
            const pct = getPercentage(r);
            if (pct >= 80) return s + 12; if (pct >= 75) return s + 11; if (pct >= 70) return s + 10;
            if (pct >= 65) return s + 9; if (pct >= 60) return s + 8; if (pct >= 55) return s + 7;
            if (pct >= 50) return s + 6; if (pct >= 45) return s + 5; if (pct >= 40) return s + 4;
            if (pct >= 35) return s + 3; if (pct >= 30) return s + 2; return s + 1;
          }, 0)
        : isPrimary ? null : results.reduce((s, r) => {
            const pct = getPercentage(r);
            if (pct >= 90) return s + 8; if (pct >= 75) return s + 7; if (pct >= 58) return s + 6;
            if (pct >= 41) return s + 5; if (pct >= 31) return s + 4; if (pct >= 21) return s + 3;
            if (pct >= 11) return s + 2; return s + 1;
          }, 0);
      const deviation = previousAvg !== null ? avgPercentage - previousAvg : null;
      const isNew = deviation === null;
      const position = results[0]?.class_position || results[0]?.position || null;
      const positionStr = formatPosition(position, totalStudents || 0);
      const subjectScores = results.map(r => ({ name: r.subjects?.name || 'Unknown', pct: getPercentage(r) }));
      const sortedBest = [...subjectScores].sort((a, b) => b.pct - a.pct);
      const bestSubject = sortedBest[0]?.name || 'all subjects';
      const weakestSubject = sortedBest[sortedBest.length - 1]?.name || 'some subjects';
      const studentFullName = `${selectedChild.first_name} ${selectedChild.last_name}`;
      const aiComment = generateUniqueAIComment(
        studentFullName, avgPercentage, deviation, bestSubject, weakestSubject,
        position, totalStudents || 0, isNew, classDataForGrading
      );

      await drawReportHeader(doc, schoolInfo);
      const photoUrl = selectedChild.photo_url || null;
      if (photoUrl) {
        // Top-right header portrait; 27mm is approximately 102px at 96 DPI.
        await addStudentPhotoToPDF(doc, photoUrl, 173, 2.5, 27);
      }
      drawStudentInfo(doc, studentFullName, selectedChild.admission_number || 'N/A', classDataForGrading.name || 'N/A', term?.name || '', term?.academic_year || '', positionStr);
      const tableEndY = drawResultsTable(doc, results, classDataForGrading, 70);
      const summaryEndY = drawSummaryBox(doc, results, avgPercentage, totalPoints, positionStr, classDataForGrading, tableEndY + 10);
      const devEndY = drawDeviation(doc, deviation, previousAvg, summaryEndY);
      let trendEndY = devEndY;
      if (trendData.length >= 2) {
        drawTrendGraph(doc, trendData, 14, devEndY, 182, 50, band, is844);
        trendEndY = devEndY + 55;
      }
      const myBestSubjects = classBestList.filter(b => b.studentId === selectedChild.id);
      const achievementEndY = drawAchievements(doc, myBestSubjects, trendEndY);
      const commentEndY = drawAIComment(doc, aiComment, achievementEndY);
      addSignaturesToPDF(doc, signatures, commentEndY, schoolInfo);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text('Kimatu Analytics | Support: support@kimatu.company', 105, 285, { align: 'center' });
      doc.save(`report_card_${selectedChild.first_name}_${term?.name}.pdf`);
      toast.success('Report card downloaded!');
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
      console.error(err);
    }
    setGenerating(false);
  };

  const handleDownloadPDF = useCallback(async () => {
    if (!selectedChild || !results.length) { toast.error('No results found'); return; }
    if (schoolPayConfig?.parent_pay_enabled) {
      const paid = await checkPdfPaid(selectedChild.id);
      if (paid) { await doGeneratePDF(); return; }
      setPaying(true);
      try {
        await loadPaystackScript();
        if (!window.PaystackPop) throw new Error('Paystack not loaded');
        const amount = schoolPayConfig.pdf_report_fee;
        const reference = `pdf_${selectedChild.id}_${Date.now()}`;
        const handler = window.PaystackPop.setup({
          key: schoolPayConfig.reseller_paystack_public_key!,
          email: user!.email,
          amount: amount * 100,
          currency: 'KES',
          ref: reference,
          metadata: {
            custom_fields: [
              { display_name: 'Student', variable_name: 'student', value: `${selectedChild.first_name} ${selectedChild.last_name}` },
              { display_name: 'Payment Type', variable_name: 'type', value: 'PDF Report Card' },
            ],
          },
          callback: async (response: any) => {
            const { error } = await supabaseUntyped.from('parent_payments').insert({
              parent_id: user!.id,
              parent_name: `${user!.firstName} ${user!.lastName}`,
              student_id: selectedChild.id,
              student_name: `${selectedChild.first_name} ${selectedChild.last_name}`,
              school_id: schoolPayConfig.school_id,
              reseller_id: schoolPayConfig.reseller_id,
              amount: amount,
              payment_type: 'pdf_report',
              status: 'success',
              paystack_reference: response.reference || reference,
            });
            if (error) { toast.error('Payment saved but failed to record: ' + error.message); }
            else {
              toast.success(`Payment of KES ${amount} successful! Generating PDF...`);
              setPdfPaid(prev => ({ ...prev, [selectedChild.id]: true }));
              await doGeneratePDF();
            }
            setPaying(false);
          },
          onClose: () => { toast.info('Payment cancelled'); setPaying(false); },
        });
        handler.openIframe();
      } catch (err: any) { toast.error(err.message || 'Payment failed'); setPaying(false); }
    } else { await doGeneratePDF(); }
  }, [selectedChild, results, schoolPayConfig, user, pdfPaid, selectedTerm, terms, schoolInfo, signatures, classBestList, previousAvg, trendData, totalStudents]);

  const isPdfPaid = selectedChild ? !!pdfPaid[selectedChild.id] : false;
  const requiresPayment = !!(schoolPayConfig?.parent_pay_enabled && !isPdfPaid);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#111111]">Child Report Card</h1>
        <p className="text-sm text-[#666666]">Download your child's academic report card</p>
      </div>

      {schoolInfo.logo_url && (
        <div className="bg-white rounded-2xl p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] flex items-center gap-4">
          <img src={schoolInfo.logo_url} alt="School Logo" className="h-12 w-auto object-contain" />
          <div>
            <p className="font-semibold text-[#111111]">{schoolInfo.name}</p>
            {schoolInfo.motto && <p className="text-xs text-[#666666] italic">"{schoolInfo.motto}"</p>}
          </div>
        </div>
      )}

      {children.length === 0 ? (
        <div className="bg-white rounded-2xl p-8 text-center shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
          <Users className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-[#666666]">No children linked to your account. Please contact the school administrator.</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
            <h3 className="font-semibold text-[#111111] mb-4">Select Child &amp; Term</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Child</label>
                <select
                  value={selectedChild?.id || ''}
                  onChange={e => {
                    const child = children.find(c => c.id === e.target.value);
                    setSelectedChild(child);
                    if (child) {
                      fetchTerms(child.school_id);
                      fetchSchoolPayConfig(child.school_id);
                      fetchSchoolInfo(child.school_id);
                      fetchSignatures(child.school_id, child.classes?.class_teacher_id);
                      fetchTotalStudents(child.class_id, child.school_id);
                    }
                  }}
                  className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] bg-white"
                >
                  {children.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name} - {c.classes?.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Term</label>
                <select value={selectedTerm} onChange={e => setSelectedTerm(e.target.value)} className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] bg-white">
                  {terms.map(t => <option key={t.id} value={t.id}>{t.name} {t.academic_year}</option>)}
                </select>
              </div>
            </div>
          </div>
          {results.length > 0 ? (
            <div className="bg-white rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-[#111111]">{selectedChild?.first_name}&apos;s Results ({results.length} subjects)</h3>
                <div className="flex gap-2 items-center">
                  {isPdfPaid && <span className="flex items-center gap-1 text-xs text-green-600 font-medium"><CheckCircle className="w-3.5 h-3.5" /> Paid</span>}
                  <button onClick={handleDownloadPDF} disabled={generating || paying}
                    className="flex items-center gap-2 bg-[#2563EB] text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-[#1d4ed8] disabled:opacity-50">
                    {generating || paying ? <Loader2 className="w-4 h-4 animate-spin" /> : requiresPayment ? <Lock className="w-4 h-4" /> : <Download className="w-4 h-4" />}
                    {generating ? 'Generating...' : paying ? 'Processing...' : requiresPayment ? `Pay KES ${schoolPayConfig?.pdf_report_fee || 50} & Download PDF` : 'Download PDF'}
                  </button>
                  <button onClick={() => {
                    const term = terms.find((t: any) => t.id === selectedTerm);
                    const avg = results.length ? Math.round(results.reduce((s: number, r: any) => s + (r.percentage || r.marks || 0), 0) / results.length) : 0;
                    const text = encodeURIComponent(`${selectedChild?.first_name}'s Kimatu Analytics Report Card\nTerm: ${term?.name || ''} ${term?.academic_year || ''}\nAverage: ${avg}%\nView at: ${window.location.origin}`);
                    window.open(`https://wa.me/?text=${text}`, '_blank');
                  }} className="flex items-center gap-2 bg-green-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-green-700">
                    <Share2 className="w-4 h-4" /> WhatsApp
                  </button>
                </div>
              </div>
              {requiresPayment && (
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center gap-2 text-blue-700 text-sm">
                  <CreditCard className="w-4 h-4 flex-shrink-0" />
                  <span>A one-time payment of <strong>KES {schoolPayConfig?.pdf_report_fee || 50}</strong> is required to download the PDF report card.</span>
                </div>
              )}

              {trendData.length >= 2 && (
                <div className="mb-4 p-4 bg-gray-50 rounded-xl">
                  <p className="text-xs font-semibold text-gray-600 mb-2">Performance Trend</p>
                  <div className="flex items-end gap-3 h-24">
                    {trendData.map((t, i) => {
                      const height = Math.max(10, (t.avg / 100) * 80);
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1">
                          <span className="text-xs font-bold text-blue-600">{t.avg.toFixed(0)}%</span>
                          <div className="w-full bg-blue-200 rounded-t" style={{ height: `${height}px` }} />
                          <span className="text-xs text-gray-500 truncate max-w-full">{t.term}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="text-left text-xs font-medium text-[#666666] uppercase py-2 px-3">Learning Area</th>
                      <th className="text-left text-xs font-medium text-[#666666] uppercase py-2 px-3">Marks</th>
                      <th className="text-left text-xs font-medium text-[#666666] uppercase py-2 px-3">%</th>
                      <th className="text-left text-xs font-medium text-[#666666] uppercase py-2 px-3">{is844 ? '8-4-4 Grade' : 'CBE Grade'}</th>
                      {!isPrimary && <th className="text-left text-xs font-medium text-[#666666] uppercase py-2 px-3">Points</th>}
                      <th className="text-left text-xs font-medium text-[#666666] uppercase py-2 px-3">Descriptor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, i) => {
                      const pct = r.percentage !== undefined && r.percentage !== null ? r.percentage : Math.round((r.marks / (r.out_of || 100)) * 100);
                      const grading = (() => {
                        if (is844) {
                          if (pct >= 80) return { grade: 'A', points: 12, descriptor: 'Excellent' };
                          if (pct >= 75) return { grade: 'A-', points: 11, descriptor: 'Very Good' };
                          if (pct >= 70) return { grade: 'B+', points: 10, descriptor: 'Good' };
                          if (pct >= 65) return { grade: 'B', points: 9, descriptor: 'Good' };
                          if (pct >= 60) return { grade: 'B-', points: 8, descriptor: 'Good' };
                          if (pct >= 55) return { grade: 'C+', points: 7, descriptor: 'Average' };
                          if (pct >= 50) return { grade: 'C', points: 6, descriptor: 'Average' };
                          if (pct >= 45) return { grade: 'C-', points: 5, descriptor: 'Average' };
                          if (pct >= 40) return { grade: 'D+', points: 4, descriptor: 'Below Average' };
                          if (pct >= 35) return { grade: 'D', points: 3, descriptor: 'Below Average' };
                          if (pct >= 30) return { grade: 'D-', points: 2, descriptor: 'Below Average' };
                          return { grade: 'E', points: 1, descriptor: 'Poor' };
                        }
                        const b = getSchoolLevelBand(classDataForGrading);
                        const g = (() => {
                          if (b === 'junior' || b === 'senior') {
                            if (pct >= 90) return { subLevel: 'EE1', grade: 'EE', points: 8 };
                            if (pct >= 75) return { subLevel: 'EE2', grade: 'EE', points: 7 };
                            if (pct >= 58) return { subLevel: 'ME1', grade: 'ME', points: 6 };
                            if (pct >= 41) return { subLevel: 'ME2', grade: 'ME', points: 5 };
                            if (pct >= 31) return { subLevel: 'AE1', grade: 'AE', points: 4 };
                            if (pct >= 21) return { subLevel: 'AE2', grade: 'AE', points: 3 };
                            if (pct >= 11) return { subLevel: 'BE1', grade: 'BE', points: 2 };
                            return { subLevel: 'BE2', grade: 'BE', points: 1 };
                          }
                          if (pct >= 75) return { subLevel: 'EE', grade: 'EE', points: 0 };
                          if (pct >= 41) return { subLevel: 'ME', grade: 'ME', points: 0 };
                          if (pct >= 21) return { subLevel: 'AE', grade: 'AE', points: 0 };
                          return { subLevel: 'BE', grade: 'BE', points: 0 };
                        })();
                        return { grade: g.subLevel, points: g.points, descriptor: g.grade === 'EE' ? 'Exceeding Expectation' : g.grade === 'ME' ? 'Meeting Expectation' : g.grade === 'AE' ? 'Approaching Expectation' : 'Below Expectation' };
                      })();
                      return (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-2 px-3 font-medium">{r.subjects?.name}</td>
                          <td className="py-2 px-3">{r.marks}</td>
                          <td className="py-2 px-3">{pct}%</td>
                          <td className="py-2 px-3">
                            <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                              grading.grade.startsWith('EE') || grading.grade.startsWith('A') ? 'bg-green-100 text-green-700' :
                              grading.grade.startsWith('ME') || grading.grade.startsWith('B') || grading.grade.startsWith('C') ? 'bg-blue-100 text-blue-700' :
                              grading.grade.startsWith('AE') || grading.grade.startsWith('D') ? 'bg-orange-100 text-orange-700' :
                              'bg-red-100 text-red-700'
                            }`}>{grading.grade}</span>
                          </td>
                          {!isPrimary && <td className="py-2 px-3">{grading.points ?? '—'}</td>}
                          <td className="py-2 px-3 text-xs text-gray-600">{grading.descriptor}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              {classBestList.filter(b => b.studentId === selectedChild?.id).length > 0 && (
                <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">🏆</span>
                    <span className="text-sm font-bold text-yellow-800">{selectedChild?.first_name}&apos;s Achievements This Term</span>
                  </div>
                  {classBestList.filter(b => b.studentId === selectedChild?.id).map((b, i) => (
                    <div key={i} className="text-sm text-yellow-900">
                      Your child scored highest in <strong>{b.subjectName}</strong>: {b.percentage}% — {b.gradeLabel}{b.points !== null ? ` (${b.points} pts)` : ''}
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl p-8 text-center shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
              <FileText className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-[#666666]">No results found for this term.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
