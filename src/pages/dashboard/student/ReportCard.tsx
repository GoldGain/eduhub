import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabaseUntyped } from '@/lib/supabase/client';
import { Download, FileText, Loader2, Share2 } from 'lucide-react';
import PhotoZoomModal from '@/components/PhotoZoomModal';
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

export default function StudentReportCard() {
  const { user, schoolData } = useAuth();
  const [student, setStudent] = useState<any>(null);
  const [zoomPhoto, setZoomPhoto] = useState<string | null>(null);
  const [results, setResults] = useState<any[]>([]);
  const [terms, setTerms] = useState<any[]>([]);
  const [selectedTerm, setSelectedTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [previousAvg, setPreviousAvg] = useState<number | null>(null);
  const [totalStudents, setTotalStudents] = useState(0);
  const [schoolInfo, setSchoolInfo] = useState<SchoolInfo>({ name: '' });
  const [signatures, setSignatures] = useState<SignatureInfo>({});
  const [classBestList, setClassBestList] = useState<BestInSubject[]>([]);
  const [trendData, setTrendData] = useState<{ term: string; avg: number }[]>([]);

  useEffect(() => { fetchData(); }, [user?.id]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: studentData } = await supabaseUntyped
        .from('students')
        .select('*, classes(name, level, grade_level, curriculum, class_teacher_id)')
        .eq('profile_id', user?.id)
        .single();
      setStudent(studentData);
      if (studentData) {
        const { count } = await supabaseUntyped
          .from('students')
          .select('id', { count: 'exact', head: true })
          .eq('class_id', studentData.class_id)
          .eq('school_id', studentData.school_id);
        setTotalStudents(count || 0);

        const { data: termsData } = await supabaseUntyped
          .from('terms')
          .select('*')
          .eq('school_id', studentData.school_id)
          .order('academic_year', { ascending: false });
        setTerms(termsData || []);
        if (termsData && termsData.length > 0) {
          setSelectedTerm(termsData[0].id);
        }

        // Fetch school info (logo, principal, etc.)
        await fetchSchoolInfo(studentData.school_id);
        // Fetch signatures
        await fetchSignatures(studentData.school_id, studentData.classes?.class_teacher_id);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
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
    // Principal signature — column now exists after migration
    let principalSigUrl: string | null = null;
    try {
      const { data: schoolSig } = await supabaseUntyped
        .from('schools')
        .select('principal_signature_url')
        .eq('id', schoolId)
        .maybeSingle();
      principalSigUrl = schoolSig?.principal_signature_url || null;
    } catch {
      // Column may not exist on older deployments — ignore
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
        // Ignore errors fetching teacher signature
      }
    }

    setSignatures(prev => ({
      ...prev,
      principal_signature_url: principalSigUrl,
      teacher_signature_url: teacherSigUrl,
    }));
  };

  useEffect(() => {
    if (selectedTerm && student) {
      fetchResults();
      fetchTrendData();
    }
  }, [selectedTerm, student]);

  const fetchResults = async () => {
    if (!student || !selectedTerm) return;
    const { data } = await supabaseUntyped
      .from('results')
      .select('*, subjects(name), terms(name, academic_year)')
      .eq('student_id', student.id)
      .eq('term_id', selectedTerm)
      .order('subjects(name)');
    setResults(data || []);
    await fetchPreviousAvg();
    // Fetch class-wide best per subject
    const { data: classResults } = await supabaseUntyped
      .from('results')
      .select('*, students(id, first_name, last_name), subjects(name)')
      .eq('class_id', student.class_id)
      .eq('term_id', selectedTerm);
    if (classResults && classResults.length > 0) {
      setClassBestList(computeBestPerSubject(classResults, student?.classes || {}));
    } else {
      setClassBestList([]);
    }
  };

  const fetchTrendData = async () => {
    if (!student) return;
    const { data: allResults } = await supabaseUntyped
      .from('results')
      .select('percentage, marks, out_of, term_id, terms(name, academic_year)')
      .eq('student_id', student.id)
      .order('terms(academic_year)', { ascending: true })
      .order('terms(name)', { ascending: true });
    if (!allResults) return;

    const termMap: Record<string, { term: string; total: number; count: number }> = {};
    allResults.forEach((r: any) => {
      const tid = r.term_id;
      const tname = r.terms?.name || '';
      const year = r.terms?.academic_year || '';
      const key = `${year}-${tname}`;
      const pct = r.percentage !== undefined && r.percentage !== null ? Number(r.percentage) : (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0);
      if (!termMap[key]) termMap[key] = { term: `${tname} ${year}`, total: 0, count: 0 };
      termMap[key].total += pct;
      termMap[key].count++;
    });

    const trend = Object.values(termMap).map(t => ({
      term: t.term,
      avg: t.count > 0 ? t.total / t.count : 0,
    }));
    setTrendData(trend);
  };

  const fetchPreviousAvg = async () => {
    if (!student || !selectedTerm || terms.length === 0) { setPreviousAvg(null); return; }
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
      .eq('student_id', student.id)
      .eq('term_id', prevTerm.id);
    if (!prevResults || prevResults.length === 0) { setPreviousAvg(null); return; }
    const totalPct = prevResults.reduce((s: number, r: any) => s + (r.percentage || (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0)), 0);
    setPreviousAvg(totalPct / prevResults.length);
  };

  const classDataForGrading = student?.classes || {};
  const is844 = (classDataForGrading?.curriculum || 'CBE') === '844';
  const band = getSchoolLevelBand(classDataForGrading);
  // Pre-Primary (PP1/PP2) uses same display as Primary: no sub-level, no points column
  const isPrimary = band === 'primary' || band === 'pre-primary';

  const generatePDF = async () => {
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
        : isPrimary
          ? null
          : results.reduce((s, r) => {
              const pct = getPercentage(r);
              if (pct >= 90) return s + 8; if (pct >= 75) return s + 7; if (pct >= 58) return s + 6;
              if (pct >= 41) return s + 5; if (pct >= 31) return s + 4; if (pct >= 21) return s + 3;
              if (pct >= 11) return s + 2; return s + 1;
            }, 0);

      const deviation = previousAvg !== null ? avgPercentage - previousAvg : null;
      const isNew = deviation === null;
      const position = results[0]?.class_position || results[0]?.position || null;
      const positionStr = formatPosition(position, totalStudents || 0);

      // AI comment — subject-specific with all scores
      const subjectScores = results.map(r => ({
        name: r.subjects?.name || 'Unknown',
        percentage: getPercentage(r),
        previousPercentage: null,
      }));
      const sortedBest = [...subjectScores].sort((a, b) => b.percentage - a.percentage);
      const bestLearningArea = sortedBest[0]?.name || 'all subjects';
      const weakestLearningArea = sortedBest[sortedBest.length - 1]?.name || 'some subjects';
      const studentFullName = `${student.first_name} ${student.last_name}`;
      const aiComment = generateUniqueAIComment(
        studentFullName, avgPercentage, deviation, bestLearningArea, weakestLearningArea,
        position, totalStudents || 0, isNew, classDataForGrading, subjectScores
      );

      // Header with logo
      await drawReportHeader(doc, schoolInfo);

      // Student photo in the top-right of the header. 27mm is approximately
      // 102px at 96 DPI, meeting the minimum size without covering term data.
      const photoUrl = student.photo_url || null;
      if (photoUrl) {
        try {
          await addStudentPhotoToPDF(doc, photoUrl, 173, 2.5, 27);
        } catch {}
      }

      // Student info
      drawStudentInfo(
        doc,
        studentFullName,
        student.admission_number || 'N/A',
        classDataForGrading.name || 'N/A',
        term?.name || '',
        term?.academic_year || '',
        positionStr,
      );

      // Results table
      const tableEndY = drawResultsTable(doc, results, classDataForGrading, 70);

      // Summary
      const summaryEndY = drawSummaryBox(doc, results, avgPercentage, totalPoints, positionStr, classDataForGrading, tableEndY + 10);

      // Deviation
      const devEndY = drawDeviation(doc, deviation, previousAvg, summaryEndY);

      // Performance trend graph
      let trendEndY = devEndY;
      if (trendData.length >= 2) {
        drawTrendGraph(doc, trendData, 14, devEndY, 182, 50, band, is844);
        trendEndY = devEndY + 55;
      }

      // Achievements
      const myBestLearningAreas = classBestList.filter((b: BestInSubject) => b.studentId === student.id);
      const achievementEndY = drawAchievements(doc, myBestLearningAreas, trendEndY);

      // AI Comment
      const commentEndY = drawAIComment(doc, aiComment, achievementEndY);

      // Signatures
      addSignaturesToPDF(doc, signatures, commentEndY, schoolInfo);

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text('Kimatu Analytics School Management System | Support: tutorsultimate@gmail.com | kimatu.company', 105, 285, { align: 'center' });

      doc.save(`report_card_${student.first_name}_${student.last_name}_${term?.name}.pdf`);
      toast.success('Report card downloaded!');
    } catch (err: any) {
      toast.error('Failed to generate PDF: ' + err.message);
      console.error(err);
    }
    setGenerating(false);
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#111111]">Report Card</h1>
        <p className="text-sm text-[#666666]">Download your official academic report card</p>
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

      {student && (
        <div className="bg-white rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-bold text-[#111111]">{student.first_name} {student.last_name}</h2>
              <p className="text-sm text-[#666666]">Admission: {student.admission_number}</p>
              <p className="text-sm text-[#666666]">Class: {student.classes?.name}</p>
            </div>
{zoomPhoto && <PhotoZoomModal photoUrl={zoomPhoto} altText={student.first_name} onClose={() => setZoomPhoto(null)} />}
            {student.photo_url ? (
              <img
                src={student.photo_url}
                alt={student.first_name}
                className="w-20 h-20 rounded-full object-cover border-2 border-blue-200 cursor-zoom-in hover:border-blue-400 hover:shadow-lg transition-all"
                onClick={() => setZoomPhoto(student.photo_url)}
                title="Click to zoom"
              />
            ) : (
              <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center">
                <span className="text-2xl font-bold text-blue-600">{student.first_name?.[0]}{student.last_name?.[0]}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
        <h3 className="font-semibold text-[#111111] mb-4">Select Term</h3>
        <select
          value={selectedTerm}
          onChange={e => setSelectedTerm(e.target.value)}
          className="w-full md:w-64 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] bg-white"
        >
          <option value="">Select Term</option>
          {terms.map(t => <option key={t.id} value={t.id}>{t.name} {t.academic_year}</option>)}
        </select>
      </div>

      {results.length > 0 && (
        <div className="bg-white rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-[#111111]">Results Preview ({results.length} subjects)</h3>
            <div className="flex gap-2">
              <button
                onClick={generatePDF}
                disabled={generating}
                className="flex items-center gap-2 bg-[#2563EB] text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-[#1d4ed8] disabled:opacity-50"
              >
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {generating ? 'Generating...' : 'Download PDF'}
              </button>
              <button
                onClick={() => {
                  const term = terms.find(t => t.id === selectedTerm);
                  const avg = results.length ? Math.round(results.reduce((s, r) => s + getPercentage(r), 0) / results.length) : 0;
                  const text = encodeURIComponent(`My Kimatu Analytics Report Card\nTerm: ${term?.name || ''} ${term?.academic_year || ''}\nAverage: ${avg}%\nView at: ${window.location.origin}`);
                  window.open(`https://wa.me/?text=${text}`, '_blank');
                }}
                className="flex items-center gap-2 bg-green-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-green-700"
              >
                <Share2 className="w-4 h-4" />
                WhatsApp
              </button>
            </div>
          </div>

          {/* Trend Graph */}
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
                  const percentage = getPercentage(r);
                  const grading = (() => {
                    if (is844) {
                      if (percentage >= 80) return { grade: 'A', points: 12, descriptor: 'Excellent' };
                      if (percentage >= 75) return { grade: 'A-', points: 11, descriptor: 'Very Good' };
                      if (percentage >= 70) return { grade: 'B+', points: 10, descriptor: 'Good' };
                      if (percentage >= 65) return { grade: 'B', points: 9, descriptor: 'Good' };
                      if (percentage >= 60) return { grade: 'B-', points: 8, descriptor: 'Good' };
                      if (percentage >= 55) return { grade: 'C+', points: 7, descriptor: 'Average' };
                      if (percentage >= 50) return { grade: 'C', points: 6, descriptor: 'Average' };
                      if (percentage >= 45) return { grade: 'C-', points: 5, descriptor: 'Average' };
                      if (percentage >= 40) return { grade: 'D+', points: 4, descriptor: 'Below Average' };
                      if (percentage >= 35) return { grade: 'D', points: 3, descriptor: 'Below Average' };
                      if (percentage >= 30) return { grade: 'D-', points: 2, descriptor: 'Below Average' };
                      return { grade: 'E', points: 1, descriptor: 'Poor' };
                    }
                    const band = getSchoolLevelBand(classDataForGrading);
                    const g = (() => {
                      if (band === 'junior' || band === 'senior') {
                        if (percentage >= 90) return { subLevel: 'EE1', grade: 'EE', points: 8 };
                        if (percentage >= 75) return { subLevel: 'EE2', grade: 'EE', points: 7 };
                        if (percentage >= 58) return { subLevel: 'ME1', grade: 'ME', points: 6 };
                        if (percentage >= 41) return { subLevel: 'ME2', grade: 'ME', points: 5 };
                        if (percentage >= 31) return { subLevel: 'AE1', grade: 'AE', points: 4 };
                        if (percentage >= 21) return { subLevel: 'AE2', grade: 'AE', points: 3 };
                        if (percentage >= 11) return { subLevel: 'BE1', grade: 'BE', points: 2 };
                        return { subLevel: 'BE2', grade: 'BE', points: 1 };
                      }
                      if (percentage >= 75) return { subLevel: 'EE', grade: 'EE', points: 0 };
                      if (percentage >= 41) return { subLevel: 'ME', grade: 'ME', points: 0 };
                      if (percentage >= 21) return { subLevel: 'AE', grade: 'AE', points: 0 };
                      return { subLevel: 'BE', grade: 'BE', points: 0 };
                    })();
                    return { grade: g.subLevel, points: g.points, descriptor: g.grade === 'EE' ? 'Exceeding Expectation' : g.grade === 'ME' ? 'Meeting Expectation' : g.grade === 'AE' ? 'Approaching Expectation' : 'Below Expectation' };
                  })();
                  return (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-2 px-3 font-medium">{r.subjects?.name}</td>
                      <td className="py-2 px-3">{r.marks}</td>
                      <td className="py-2 px-3">{percentage}%</td>
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
          </div>

          {classBestList.filter(b => b.studentId === student?.id).length > 0 && (
            <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">🏆</span>
                <span className="text-sm font-bold text-yellow-800">Your Achievements This Term</span>
              </div>
              {classBestList.filter(b => b.studentId === student?.id).map((b, i) => (
                <div key={i} className="text-sm text-yellow-900">
                  You were the best in <strong>{b.subjectName}</strong>: {b.percentage}% — {b.gradeLabel}{b.points !== null ? ` (${b.points} pts)` : ''}
                </div>
              ))}
            </div>
          )}

          {previousAvg !== null && (
            <div className="mt-4 p-3 bg-blue-50 rounded-xl text-sm text-blue-700">
              <strong>Deviation from previous term:</strong> {
                (() => {
                  const totalPct = results.reduce((s, r) => s + getPercentage(r), 0);
                  const avg = results.length ? totalPct / results.length : 0;
                  const dev = avg - previousAvg;
                  return dev >= 0 ? `▲ +${dev.toFixed(1)}% improvement` : `▼ ${dev.toFixed(1)}% drop`;
                })()
              } (Previous term avg: {previousAvg.toFixed(1)}%)
            </div>
          )}
        </div>
      )}
      {results.length === 0 && selectedTerm && (
        <div className="bg-white rounded-2xl p-8 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] text-center">
          <FileText className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-[#666666]">No results found for this term. Results will appear here once your teacher uploads them.</p>
        </div>
      )}
    </div>
  );
}
