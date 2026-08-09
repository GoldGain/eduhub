import { useState, useEffect } from 'react';
import { supabaseUntyped } from "@/lib/supabase/client";
import { useAuth } from '@/contexts/AuthContext';
import { Search, Award, Download, FileText, Loader2, TrendingUp, TrendingDown, Minus, Send, Bell, Trophy, Pencil, Trash2, X } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { toast } from 'sonner';

// ── Grade helpers ──────────────────────────────────────────────────────────────
import { calculateCompetencyGrade, getSchoolLevelBand, calculate844Grade } from '@/lib/grading';
import type { SchoolLevelBand } from '@/lib/grading';
import { computeBestPerSubject } from '@/lib/bestPerSubject';
import type { BestInSubject } from '@/lib/bestPerSubject';
import {
  generateUniqueAIComment,
  drawTrendGraph,
  addSignaturesToPDF,
  drawReportHeader,
  addStudentPhotoToPDF,
  addLogoToPDF,
  type SchoolInfo,
  type SignatureInfo,
} from '@/lib/reportCardPdf';
import { loadSchoolBranding, resolveSchoolName } from '@/lib/schoolBranding';

function calculateCBEGrade(pct: number, classData?: { curriculum?: string | null; grade_level?: number | string | null; level?: number | string | null; name?: string | null }) {
  const band = getSchoolLevelBand(classData);
  const g = calculateCompetencyGrade(pct, band === '844' ? 'junior' : band);
  return { subLevel: g.subLevel, grade: g.grade, points: g.points };
}

function overallGradeLabelCBC(avgPct: number): string {
  if (avgPct >= 75) return 'EE';
  if (avgPct >= 41) return 'ME';
  if (avgPct >= 21) return 'AE';
  return 'BE';
}

function overallGradeWithBand(avgPct: number, band: SchoolLevelBand) {
  const g = calculateCompetencyGrade(avgPct, band);
  return { subLevel: g.subLevel, grade: g.grade, points: g.points, descriptor: g.descriptor };
}

function overallGrade844(avgPct: number) {
  return calculate844Grade(avgPct);
}

const SUBJECT_SHORT: Record<string, string> = {
  'English': 'ENG', 'Kiswahili': 'KISW', 'Mathematics': 'MATH',
  'Integrated Science': 'INTSCI', 'Social Studies': 'SST',
  'Creative Arts & Sports': 'CAS', 'Pre-Technical Studies': 'PRE-TECH',
  'Christian Religious Education': 'CRE', 'Agriculture': 'AGRI',
};
function shortName(name: string) {
  return SUBJECT_SHORT[name] || name.substring(0, 7).toUpperCase();
}

export default function SchoolAdminResults() {
  const { user, schoolData } = useAuth();
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [classes, setClasses] = useState<any[]>([]);
  const [terms, setTerms] = useState<any[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedTerm, setSelectedTerm] = useState('');
  const [generatingPDF, setGeneratingPDF] = useState(false);
  const [generatingBulk, setGeneratingBulk] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Edit state
  const [editingResult, setEditingResult] = useState<any | null>(null);
  const [editMarks, setEditMarks] = useState('');
  const [editOutOf, setEditOutOf] = useState('');
  const [savingResult, setSavingResult] = useState(false);

  // Delete state
  const [deletingResult, setDeletingResult] = useState<any | null>(null);
  const [deletingResultLoading, setDeletingResultLoading] = useState(false);
  const [schoolName, setSchoolName] = useState('');
  const [bestPerSubjectList, setBestPerSubjectList] = useState<BestInSubject[]>([]);
  const [schoolInfo, setSchoolInfo] = useState<SchoolInfo>({ name: '' });
  const [principalSignatureUrl, setPrincipalSignatureUrl] = useState<string | null>(null);

  useEffect(() => { fetchAll(); }, []);

  const getPercentage = (r: any) => {
    if (r.percentage !== undefined && r.percentage !== null) return Number(r.percentage);
    return Math.round((r.marks / (r.out_of || 100)) * 100);
  };

  const fetchAll = async () => {
    setLoading(true);
    const schoolId = user?.schoolId ?? '';
    if (!schoolId) {
      setLoading(false);
      return;
    }

    try {
      const [resultsResponse, classesResponse, termsResponse, brandingResponse] = await Promise.all([
        supabaseUntyped.from('results').select('*, students(first_name, last_name, admission_number), subjects(name), classes(curriculum, grade_level, level, name)').eq('school_id', schoolId).order('created_at', { ascending: false }),
        supabaseUntyped.from('classes').select('*').eq('school_id', schoolId).order('level'),
        supabaseUntyped.from('terms').select('*').eq('school_id', schoolId).order('academic_year', { ascending: false }),
        loadSchoolBranding(supabaseUntyped, schoolId, resolveSchoolName(schoolData?.name)),
      ]);

      if (resultsResponse.error) throw resultsResponse.error;
      if (classesResponse.error) throw classesResponse.error;
      if (termsResponse.error) throw termsResponse.error;

      setResults((resultsResponse.data as any[]) || []);
      setClasses((classesResponse.data as any[]) || []);
      setTerms((termsResponse.data as any[]) || []);

      if (!brandingResponse.found) {
        console.error('Unable to load complete school branding:', brandingResponse.error);
      }
      const branding = brandingResponse.data;
      setSchoolName(branding.name);
      setSchoolInfo(branding);
      setPrincipalSignatureUrl(branding.principal_signature_url);
    } catch (err: any) {
      console.error('Failed to load results page:', err);
      toast.error('Failed to load results: ' + (err.message || 'Unknown error'));
    } finally {
      setLoading(false);
    }
  };

  const filtered = results.filter(r =>
    r.students?.first_name?.toLowerCase().includes(search.toLowerCase()) ||
    r.students?.last_name?.toLowerCase().includes(search.toLowerCase()) ||
    r.subjects?.name?.toLowerCase().includes(search.toLowerCase())
  );

  const gradeColor = (grade: string) => {
    if (grade?.startsWith('EE')) return 'bg-green-100 text-green-700';
    if (grade?.startsWith('ME')) return 'bg-blue-100 text-blue-700';
    if (grade?.startsWith('AE')) return 'bg-orange-100 text-orange-700';
    return 'bg-red-100 text-red-700';
  };

  const publishResults = async () => {
    if (!selectedClass || !selectedTerm) { toast.error('Please select a class and term first'); return; }
    setPublishing(true);
    try {
      const { error: updateError } = await supabaseUntyped.from('results').update({ status: 'published', published_at: new Date().toISOString() }).eq('class_id', selectedClass).eq('term_id', selectedTerm).eq('school_id', user?.schoolId);
      if (updateError) throw updateError;
      const { data: classStudents } = await supabaseUntyped.from('students').select('id, profile_id, first_name, last_name').eq('class_id', selectedClass).eq('is_active', true);
      if (!classStudents) throw new Error('Failed to fetch students');
      const studentIds = classStudents.map(s => s.id);
      const { data: parentRelations } = await supabaseUntyped.from('parent_student_links').select('parent_id').in('student_id', studentIds);
      const parentIds = parentRelations?.map((r: any) => r.parent_id) || [];
      const allUserIds = [...classStudents.map((s: any) => s.profile_id).filter(Boolean), ...parentIds];
      const termData = terms.find(t => t.id === selectedTerm);
      const classData = classes.find(c => c.id === selectedClass);
      const notifTitle = 'Results Published';
      const notifMessage = `Results for ${classData?.name} - ${termData?.name} ${termData?.academic_year} have been published. Check your report card now!`;
      const notifications = allUserIds.map(userId => ({ user_id: userId, school_id: user?.schoolId, title: notifTitle, message: notifMessage, type: 'results_published', is_read: false, action_url: '/student/results', created_at: new Date().toISOString() }));
      if (notifications.length > 0) {
        const { error: notifError } = await supabaseUntyped.from('notifications').insert(notifications);
        if (notifError) console.warn('Notification insert warning:', notifError);
      }
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://naihzzlszvrkxrxogsuz.supabase.co';
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
        await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': supabaseAnonKey }, body: JSON.stringify({ userIds: allUserIds, title: notifTitle, message: notifMessage }) });
      } catch (pushErr) { console.warn('Push notification delivery warning:', pushErr); }
      toast.success(`Results published! ${allUserIds.length} users notified.`);
      fetchAll();
    } catch (err: any) { toast.error('Failed to publish results: ' + err.message); console.error(err); }
    setPublishing(false);
  };

  useEffect(() => {
    if (selectedClass && selectedTerm) { fetchAndComputeBestPerSubject(); } else { setBestPerSubjectList([]); }
  }, [selectedClass, selectedTerm]);

  const fetchAndComputeBestPerSubject = async () => {
    const classObj = classes.find(c => c.id === selectedClass);
    const { data } = await supabaseUntyped.from('results').select('*, students(id, first_name, last_name), subjects(name)').eq('class_id', selectedClass).eq('term_id', selectedTerm).eq('school_id', user?.schoolId);
    if (data && data.length > 0) { setBestPerSubjectList(computeBestPerSubject(data, classObj)); } else { setBestPerSubjectList([]); }
  };

  const openEditResult = (r: any) => {
    setEditingResult(r);
    setEditMarks(String(r.marks ?? ''));
    setEditOutOf(String(r.out_of ?? 100));
  };

  const handleSaveResult = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingResult) return;
    setSavingResult(true);
    try {
      const marks = parseFloat(editMarks);
      const outOf = parseFloat(editOutOf) || 100;
      if (isNaN(marks) || marks < 0 || marks > outOf) {
        toast.error(`Marks must be between 0 and ${outOf}`);
        setSavingResult(false);
        return;
      }
      const percentage = Math.round((marks / outOf) * 100);
      const classObj = classes.find(c => c.id === editingResult.class_id);
      const band = getSchoolLevelBand(classObj);
      // Pre-Primary (PP1/PP2) behaves same as Primary: no sub-level, no points
      const isPrimaryBand = band === 'primary' || band === 'pre-primary';
      const cbcResult = calculateCompetencyGrade(percentage, band === '844' ? 'junior' : band);
      const grade844Result = calculate844Grade(percentage);
      const { error } = await supabaseUntyped.from('results').update({
        marks,
        out_of: outOf,
        percentage,
        converted_marks: marks,
        // Primary: cbc_sublevel must be null (enum only accepts EE1/ME1 etc.)
        cbc_sublevel: isPrimaryBand ? null : (cbcResult.subLevel || null),
        cbc_grade: cbcResult.grade,
        cbc_points: isPrimaryBand ? null : cbcResult.points,
        cbc_descriptor: cbcResult.descriptor,
        grade_844: grade844Result.grade,
        points_844: grade844Result.points,
      }).eq('id', editingResult.id);
      if (error) throw new Error(error.message);
      toast.success('Result updated and grade recalculated!');
      setEditingResult(null);
      fetchAll();
    } catch (err: any) {
      toast.error('Failed to update result: ' + err.message);
    } finally {
      setSavingResult(false);
    }
  };

  const handleDeleteResult = async () => {
    if (!deletingResult) return;
    setDeletingResultLoading(true);
    try {
      const { error } = await supabaseUntyped.from('results').delete().eq('id', deletingResult.id);
      if (error) throw new Error(error.message);
      toast.success('Result deleted successfully.');
      setDeletingResult(null);
      fetchAll();
    } catch (err: any) {
      toast.error('Failed to delete result: ' + err.message);
    } finally {
      setDeletingResultLoading(false);
    }
  };

  const fetchClassResults = async () => {
    if (!selectedClass || !selectedTerm) { toast.error('Please select a class and term first'); return null; }
    const { data, error } = await supabaseUntyped.from('results').select('*, students(id, first_name, last_name, admission_number, gender, photo_url), subjects(name)').eq('class_id', selectedClass).eq('term_id', selectedTerm).eq('school_id', user?.schoolId);
    if (error) { toast.error('Failed to fetch results: ' + error.message); return null; }
    return data || [];
  };

  const fetchPreviousTermAvg = async (studentId: string, currentTermId: string) => {
    const currentTermObj = terms.find(t => t.id === currentTermId);
    if (!currentTermObj) return null;
    const sortedTerms = [...terms].sort((a, b) => {
      if (a.academic_year !== b.academic_year) return Number(a.academic_year) - Number(b.academic_year);
      const termNum = (n: string) => n.includes('1') ? 1 : n.includes('2') ? 2 : 3;
      return termNum(a.name) - termNum(b.name);
    });
    const currentIdx = sortedTerms.findIndex(t => t.id === currentTermId);
    if (currentIdx <= 0) return null;
    const prevTerm = sortedTerms[currentIdx - 1];
    const { data } = await supabaseUntyped.from('results').select('marks, out_of, percentage').eq('student_id', studentId).eq('term_id', prevTerm.id);
    if (!data || data.length === 0) return null;
    const totalPct = data.reduce((s: number, r: any) => s + (r.percentage || (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0)), 0);
    return totalPct / data.length;
  };

  const buildStudentSummary = (rawResults: any[], classData?: any) => {
    const band = getSchoolLevelBand(classData);
    const byStudent: Record<string, any> = {};
    rawResults.forEach((r: any) => {
      const sid = r.students?.id || r.student_id;
      if (!byStudent[sid]) { byStudent[sid] = { student: r.students, subjects: {}, totalPct: 0, totalPoints: 0, count: 0, gender: r.students?.gender || null }; }
      const pct = r.percentage !== undefined && r.percentage !== null ? Number(r.percentage) : (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0);
      const subName = r.subjects?.name || 'Unknown';
      byStudent[sid].subjects[subName] = pct;
      byStudent[sid].subjects[subName + '_grade'] = band === '844' ? (r.grade_844 || '') : (r.cbc_sublevel || '');
      byStudent[sid].subjects[subName + '_points'] = band === '844' ? (r.points_844 || 0) : (r.cbc_points || 0);
      byStudent[sid].totalPct += pct;
      byStudent[sid].totalPoints += band === '844' ? (r.points_844 || 0) : (r.cbc_points || 0);
      byStudent[sid].count += 1;
    });
    const summaries = Object.entries(byStudent).map(([sid, v]: [string, any]) => ({
      studentId: sid, student: v.student, subjects: v.subjects, avgPct: v.count > 0 ? v.totalPct / v.count : 0,
      totalPct: v.totalPct, totalPoints: v.totalPoints, subjectCount: v.count, position: 0,
      gender: v.gender || v.student?.gender || null,
    }));
    summaries.sort((a, b) => { if (b.totalPct !== a.totalPct) return b.totalPct - a.totalPct; return b.totalPoints - a.totalPoints; });
    summaries.forEach((s, i) => { s.position = i + 1; });
    return summaries;
  };

  const drawBar = (doc: jsPDF, x: number, y: number, width: number, filledPct: number, color: [number, number, number]) => {
    doc.setDrawColor(220, 220, 220); doc.setFillColor(240, 240, 240);
    doc.rect(x, y, width, 5, 'FD');
    if (filledPct > 0) { doc.setFillColor(color[0], color[1], color[2]); doc.rect(x, y, width * filledPct, 5, 'F'); }
  };

  const getPreviousTerm = (currentTermId: string) => {
    if (!terms.length) return null;
    const sortedTerms = [...terms].sort((a, b) => {
      if (a.academic_year !== b.academic_year) return Number(a.academic_year) - Number(b.academic_year);
      const termNum = (n: string) => n.includes('1') ? 1 : n.includes('2') ? 2 : 3;
      return termNum(a.name) - termNum(b.name);
    });
    const currentIdx = sortedTerms.findIndex(t => t.id === currentTermId);
    if (currentIdx <= 0) return null;
    return sortedTerms[currentIdx - 1];
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // CLASS RESULTS SUMMARY PDF (NO individual report cards)
  // ═══════════════════════════════════════════════════════════════════════════════
  const downloadClassResultsPDF = async () => {
    if (!selectedClass || !selectedTerm) { toast.error('Please select a class and term'); return; }
    setGeneratingPDF(true);
    try {
      const rawResults = await fetchClassResults();
      if (!rawResults || rawResults.length === 0) { toast.error('No results found'); setGeneratingPDF(false); return; }
      const classObj = classes.find(c => c.id === selectedClass);
      const termObj = terms.find(t => t.id === selectedTerm);
      const band = getSchoolLevelBand(classObj);
      const isPrimary = band === 'primary';
      const is844 = band === '844';
      const summaries = buildStudentSummary(rawResults, classObj);
      const allSubjects = Array.from(new Set(rawResults.map((r: any) => r.subjects?.name).filter(Boolean))) as string[];
      const totalStudents = summaries.length;
      const classMean = totalStudents > 0 ? summaries.reduce((sum, s) => sum + s.avgPct, 0) / totalStudents : 0;
      const prevAvgMap: Record<string, number | null> = {};
      for (const s of summaries) { prevAvgMap[s.studentId] = await fetchPreviousTermAvg(s.studentId, selectedTerm); }
      const subjectTotals: Record<string, { total: number; count: number }> = {};
      summaries.forEach(s => {
        Object.entries(s.subjects).forEach(([subject, marks]) => {
          if (subject.endsWith('_grade') || subject.endsWith('_points')) return;
          if (!subjectTotals[subject]) subjectTotals[subject] = { total: 0, count: 0 };
          subjectTotals[subject].total += marks as number; subjectTotals[subject].count++;
        });
      });
      const subjectStats = allSubjects.map(sub => {
        const vals = summaries.map(s => s.subjects[sub]).filter(v => v !== undefined);
        const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        const grade = is844 ? overallGrade844(mean) : overallGradeWithBand(mean, band);
        return { name: sub, mean, grade, vals };
      }).sort((a, b) => b.mean - a.mean);

      const prevTerm = getPreviousTerm(selectedTerm);
      let prevSubjectStats: Record<string, number> = {};
      if (prevTerm) {
        const { data: prevResults } = await supabaseUntyped.from('results').select('*, subjects(name)').eq('class_id', selectedClass).eq('term_id', prevTerm.id).eq('school_id', user?.schoolId);
        if (prevResults) {
          allSubjects.forEach(sub => {
            const subResults = (prevResults as any[]).filter((r: any) => r.subjects?.name === sub);
            const pcts = subResults.map((r: any) => r.percentage !== undefined ? Number(r.percentage) : (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0));
            if (pcts.length > 0) prevSubjectStats[sub] = pcts.reduce((a, b) => a + b, 0) / pcts.length;
          });
        }
      }
      const subjectImprovement = subjectStats.map(s => {
        const prev = prevSubjectStats[s.name];
        const change = prev !== undefined ? s.mean - prev : null;
        return { ...s, prevMean: prev, change };
      });
      const mostImprovedSubjects = subjectImprovement.filter(s => s.change !== null && s.change > 0).sort((a, b) => (b.change || 0) - (a.change || 0));
      const weakestSubjects = subjectImprovement.filter(s => s.change !== null && s.change < 0).sort((a, b) => (a.change || 0) - (b.change || 0));
      const needAttention = summaries.filter(s => {
        const prevAvg = prevAvgMap[s.studentId];
        return prevAvg !== null && prevAvg !== undefined && (s.avgPct - prevAvg) < -10;
      });
      const bestPerSubjectData = computeBestPerSubject(rawResults, classObj);
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      // Use schoolInfo.name (fetched from DB) for all pages
      const displaySchoolName = resolveSchoolName(schoolInfo.name, schoolName || schoolData?.name || undefined);

      // ── PAGE 1: CLASS SUMMARY ────────────────────────────────────────────────────
      {
        doc.setFillColor(37, 99, 235); doc.rect(0, 0, 210, 35, 'F');
        // Add logo to top-left if available
        const logoAdded = schoolInfo.logo_url
          ? await addLogoToPDF(doc, schoolInfo.logo_url, 10, 3, 26, 26)
          : false;
        doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont('helvetica', 'bold');
        doc.text(displaySchoolName, logoAdded ? 40 : 105, 13, { align: logoAdded ? 'left' : 'center' });
        doc.setFontSize(11);
        doc.text('CLASS RESULTS SUMMARY', logoAdded ? 40 : 105, 22, { align: logoAdded ? 'left' : 'center' });
        doc.setFontSize(9);
        doc.text(`${classObj?.name || 'Class'} — ${termObj?.name || 'Term'} ${termObj?.academic_year || ''}`, logoAdded ? 40 : 105, 30, { align: logoAdded ? 'left' : 'center' });

        const classGrade = is844 ? overallGrade844(classMean) : overallGradeWithBand(classMean, band);
        const statsY = 42;
        doc.setFillColor(245, 247, 255); doc.rect(14, statsY, 182, 30, 'F');
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0);
        doc.text(`Total Students: ${totalStudents}`, 20, statsY + 8);
        doc.text(`Class Average: ${classMean.toFixed(1)}%`, 75, statsY + 8);
        doc.text(`Class Mean Grade: ${is844 ? classGrade.grade : classGrade.subLevel}${!isPrimary ? ` (${(classGrade as any).points} ${is844 ? 'pts' : 'points'})` : ''}`, 130, statsY + 8);
        doc.text(`Grading System: ${is844 ? '8-4-4' : isPrimary ? 'Primary CBE (Marks Only)' : 'Junior CBE (With Points)'}`, 20, statsY + 18);
        doc.text(`Subjects: ${allSubjects.length}`, 130, statsY + 18);

        const gradeDistY = statsY + 38;
        doc.setFontSize(11); doc.setFont('helvetica', 'bold');
        doc.text('GRADE DISTRIBUTION', 14, gradeDistY);
        doc.setFontSize(8); doc.setFont('helvetica', 'normal');

        if (is844) {
          const grades844 = [
            { label: 'A (12pts)', min: 80, color: [22, 163, 74] }, { label: 'A- (11pts)', min: 75, color: [34, 197, 94] },
            { label: 'B+ (10pts)', min: 70, color: [56, 189, 114] }, { label: 'B (9pts)', min: 65, color: [74, 222, 128] },
            { label: 'B- (8pts)', min: 60, color: [96, 220, 140] }, { label: 'C+ (7pts)', min: 55, color: [250, 204, 21] },
            { label: 'C (6pts)', min: 50, color: [253, 224, 71] }, { label: 'C- (5pts)', min: 45, color: [253, 186, 116] },
            { label: 'D+ (4pts)', min: 40, color: [253, 164, 100] }, { label: 'D (3pts)', min: 35, color: [251, 146, 60] },
            { label: 'D- (2pts)', min: 30, color: [249, 115, 22] }, { label: 'E (1pt)', min: 0, color: [220, 38, 38] },
          ];
          let row = 0;
          for (const g of grades844) {
            const count = summaries.filter(s => { const gr = overallGrade844(s.avgPct); return gr.grade === g.label.split(' ')[0]; }).length;
            const pct = totalStudents > 0 ? count / totalStudents : 0;
            const y = gradeDistY + 10 + row * 8;
            doc.text(`${g.label}: ${count} student${count !== 1 ? 's' : ''} (${(pct * 100).toFixed(1)}%)`, 20, y);
            drawBar(doc, 90, y - 3, 80, pct, g.color as [number, number, number]);
            row++;
          }
        } else if (isPrimary) {
          const gradesP = [
            { label: 'EE (Exceeding)', min: 75, color: [22, 163, 74] }, { label: 'ME (Meeting)', min: 41, color: [37, 99, 235] },
            { label: 'AE (Approaching)', min: 21, color: [249, 115, 22] }, { label: 'BE (Below)', min: 0, color: [220, 38, 38] },
          ];
          let row = 0;
          for (const g of gradesP) {
            const count = summaries.filter(s => {
              const p = s.avgPct;
              if (g.label.startsWith('EE')) return p >= 75; if (g.label.startsWith('ME')) return p >= 41 && p < 75;
              if (g.label.startsWith('AE')) return p >= 21 && p < 41; return p < 21;
            }).length;
            const pct = totalStudents > 0 ? count / totalStudents : 0;
            const y = gradeDistY + 10 + row * 10;
            doc.text(`${g.label}: ${count} student${count !== 1 ? 's' : ''} (${(pct * 100).toFixed(1)}%)`, 20, y);
            drawBar(doc, 90, y - 3, 80, pct, g.color as [number, number, number]);
            row++;
          }
        } else {
          const gradesJ = [
            { label: 'EE1 (8pts)', min: 90, color: [22, 163, 74] }, { label: 'EE2 (7pts)', min: 75, color: [34, 197, 94] },
            { label: 'ME1 (6pts)', min: 58, color: [37, 99, 235] }, { label: 'ME2 (5pts)', min: 41, color: [96, 165, 250] },
            { label: 'AE1 (4pts)', min: 31, color: [250, 204, 21] }, { label: 'AE2 (3pts)', min: 21, color: [253, 186, 116] },
            { label: 'BE1 (2pts)', min: 11, color: [251, 146, 60] }, { label: 'BE2 (1pt)', min: 0, color: [220, 38, 38] },
          ];
          let row = 0;
          for (const g of gradesJ) {
            const count = summaries.filter(s => { const gr = overallGradeWithBand(s.avgPct, 'junior'); return gr.subLevel === g.label.split(' ')[0]; }).length;
            const pct = totalStudents > 0 ? count / totalStudents : 0;
            const y = gradeDistY + 10 + row * 8;
            doc.text(`${g.label}: ${count} student${count !== 1 ? 's' : ''} (${(pct * 100).toFixed(1)}%)`, 20, y);
            drawBar(doc, 90, y - 3, 80, pct, g.color as [number, number, number]);
            row++;
          }
        }

        const top5Y = gradeDistY + (is844 ? 108 : isPrimary ? 52 : 72);
        doc.setFontSize(10); doc.setFont('helvetica', 'bold');
        doc.text('TOP 5 PERFORMERS', 14, top5Y); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        summaries.slice(0, 5).forEach((s: any, i: number) => {
          const gr = is844 ? overallGrade844(s.avgPct) : overallGradeWithBand(s.avgPct, band);
          doc.text(`${i + 1}. ${s.student?.first_name} ${s.student?.last_name} — ${s.avgPct.toFixed(1)}% — ${is844 ? gr.grade : gr.subLevel}${!isPrimary ? ` (${(gr as any).points}pts)` : ''}`, 20, top5Y + 7 + i * 6);
        });

        const improvedY = top5Y + 42;
        doc.setFontSize(10); doc.setFont('helvetica', 'bold');
        doc.text('MOST IMPROVED STUDENTS', 14, improvedY); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        const improved = summaries.filter(s => prevAvgMap[s.studentId] !== null && prevAvgMap[s.studentId] !== undefined).map(s => ({ ...s, dev: s.avgPct - (prevAvgMap[s.studentId] as number) })).sort((a: any, b: any) => b.dev - a.dev).slice(0, 3);
        if (improved.length > 0) { improved.forEach((s: any, i: number) => { doc.text(`${i + 1}. ${s.student?.first_name} ${s.student?.last_name}: Improved by +${s.dev.toFixed(1)}%`, 20, improvedY + 7 + i * 6); }); }
        else { doc.text('No previous term data available for comparison.', 20, improvedY + 7); }

        const attentionY = improvedY + 30;
        doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(220, 38, 38);
        doc.text('STUDENTS NEEDING ATTENTION (>10% drop)', 14, attentionY); doc.setTextColor(0, 0, 0); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        const needAttentionWithDev = needAttention.map(s => ({ ...s, dev: s.avgPct - (prevAvgMap[s.studentId] as number) })).sort((a: any, b: any) => a.dev - b.dev);
        if (needAttentionWithDev.length > 0) { needAttentionWithDev.forEach((s: any, i: number) => { doc.text(`${i + 1}. ${s.student?.first_name} ${s.student?.last_name}: Dropped by ${s.dev.toFixed(1)}%`, 20, attentionY + 7 + i * 6); }); }
        else { doc.text('No students dropped by more than 10%. Great job class!', 20, attentionY + 7); }

        const bestSubjY = attentionY + (needAttentionWithDev.length > 0 ? needAttentionWithDev.length * 6 + 14 : 14);
        if (bestPerSubjectData.length > 0) {
          doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(202, 138, 4);
          doc.text('BEST STUDENT PER SUBJECT', 14, bestSubjY); doc.setTextColor(0, 0, 0); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
          bestPerSubjectData.forEach((b, i) => { const pts = b.points !== null ? ` (${b.points} pts)` : ''; doc.text(`🏆 Best in ${b.subjectName}: ${b.studentName} — ${b.percentage}% — ${b.gradeLabel}${pts}`, 20, bestSubjY + 8 + i * 6); });
        }
        doc.setFontSize(7); doc.setTextColor(150, 150, 150);
        doc.text('Generated by Kimatu Analytics School Management System', 105, 290, { align: 'center' });
      }

      // ── PAGE 2: SUBJECT PERFORMANCE ANALYSIS ────────────────────────────────
      doc.addPage();
      {
        doc.setFillColor(37, 99, 235); doc.rect(0, 0, 210, 20, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(14); doc.setFont('helvetica', 'bold');
        doc.text(displaySchoolName, 105, 8, { align: 'center' }); doc.setFontSize(10);
        doc.text('SUBJECT PERFORMANCE ANALYSIS', 105, 16, { align: 'center' });

        const subRows = subjectStats.map((s, i) => {
          const gr = is844 ? s.grade.grade : (s.grade as any).subLevel;
          let status = '→ AVERAGE';
          if (i === 0) status = '↑ STRONG'; else if (i === 1 && subjectStats.length > 3) status = '↑ GOOD';
          else if (i >= subjectStats.length - 2) status = '↓ NEEDS WORK'; if (i === subjectStats.length - 1) status = '↓ WEAK';
          return [String(i + 1), s.name, `${s.mean.toFixed(1)}%`, gr, status];
        });

        autoTable(doc, { startY: 26, head: [['Rank', 'Subject', 'Average', 'Grade', 'Status']], body: subRows, styles: { fontSize: 9, cellPadding: 2 }, headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 9, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [245, 247, 255] } });

        const afterY = (doc as any).lastAutoTable.finalY + 12;
        if (mostImprovedSubjects.length > 0) {
          doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(22, 163, 74);
          doc.text('MOST IMPROVED SUBJECTS (vs previous term):', 14, afterY); doc.setTextColor(0, 0, 0); doc.setFontSize(9); doc.setFont('helvetica', 'normal');
          mostImprovedSubjects.slice(0, 3).forEach((s, i) => { doc.text(`↑ ${s.name}: +${(s.change || 0).toFixed(1)}%`, 20, afterY + 8 + i * 6); });
        }
        if (weakestSubjects.length > 0) {
          const weakY = afterY + (mostImprovedSubjects.length > 0 ? 30 : 5);
          doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(220, 38, 38);
          doc.text('SUBJECTS NEEDING ATTENTION:', 14, weakY); doc.setTextColor(0, 0, 0); doc.setFontSize(9); doc.setFont('helvetica', 'normal');
          weakestSubjects.slice(0, 3).forEach((s, i) => { doc.text(`↓ ${s.name}: ${(s.change || 0).toFixed(1)}%`, 20, weakY + 8 + i * 6); });
        }
        doc.setFontSize(7); doc.setTextColor(150, 150, 150);
        doc.text('Generated by Kimatu Analytics School Management System', 105, 290, { align: 'center' });
      }

      // ── PAGE 3: STUDENT RESULTS TABLE ───────────────────────────────────────
      doc.addPage();
      {
        doc.setFillColor(37, 99, 235); doc.rect(0, 0, 210, 20, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(14); doc.setFont('helvetica', 'bold');
        doc.text(displaySchoolName, 105, 8, { align: 'center' }); doc.setFontSize(10);
        doc.text(`STUDENT RESULTS TABLE — ${classObj?.name || ''} — ${termObj?.name || ''} ${termObj?.academic_year || ''}`, 105, 16, { align: 'center' });

        const subjectShorts = allSubjects.map(s => shortName(s));
        const tableHeaders = isPrimary ? ['POS', 'Student', ...subjectShorts, 'Total', 'Avg%', 'Grade'] : ['POS', 'Student', ...subjectShorts, 'Total', 'Avg%', 'Pts', 'Grade'];

        const tableRows = summaries.map((s: any) => {
          const gr = is844 ? overallGrade844(s.avgPct) : overallGradeWithBand(s.avgPct, band);
          const subjectCells = allSubjects.map(sub => {
            const pct = s.subjects[sub]; if (pct === undefined) return '-';
            const subGrade = is844 ? overallGrade844(pct) : overallGradeWithBand(pct, band);
            if (isPrimary) return `${pct.toFixed(0)}% ${(subGrade as any).grade || (subGrade as any).subLevel}`;
            return `${pct.toFixed(0)}% ${(subGrade as any).subLevel || (subGrade as any).grade}`;
          });
                  if (isPrimary) { return [`${s.position}${s.position === 1 ? 'st' : s.position === 2 ? 'nd' : s.position === 3 ? 'rd' : 'th'}`, `${s.student?.first_name || ''} ${s.student?.last_name || ''}`, ...subjectCells, `${s.totalPct.toFixed(0)}`, `${s.avgPct.toFixed(1)}%`, (gr as any).grade || (gr as any).subLevel]; }
          else { return [`${s.position}${s.position === 1 ? 'st' : s.position === 2 ? 'nd' : s.position === 3 ? 'rd' : 'th'}`, `${s.student?.first_name || ''} ${s.student?.last_name || ''}`, ...subjectCells, `${s.totalPct.toFixed(0)}`, `${s.avgPct.toFixed(1)}%`, String(s.totalPoints), (gr as any).subLevel || (gr as any).grade]; }
        });

        const subjectMeans = allSubjects.map(sub => { const vals = summaries.map(s => s.subjects[sub]).filter(v => v !== undefined); return vals.length ? `${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)}%` : '-'; });
        if (isPrimary) { tableRows.push(['', 'SUBJECT MEAN', ...subjectMeans, '', `${classMean.toFixed(1)}%`, overallGradeWithBand(classMean, band).grade]); }
        else { tableRows.push(['', 'SUBJECT MEAN', ...subjectMeans, '', `${classMean.toFixed(1)}%`, '', is844 ? overallGrade844(classMean).grade : overallGradeWithBand(classMean, band).subLevel]); }

        autoTable(doc, { startY: 24, head: [tableHeaders], body: tableRows, styles: { fontSize: 6.5, cellPadding: 1 }, headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 6.5, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [245, 247, 255] }, didParseCell: (data: any) => { if (data.section === 'body' && data.row.index === tableRows.length - 1) { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [230, 240, 255]; } } });
        doc.setFontSize(7); doc.setTextColor(150, 150, 150);
        doc.text(`Ranking by Total Marks. ${isPrimary ? 'No points — marks only.' : 'Points shown for Junior CBE grading.'} | Generated by Kimatu Analytics`, 105, 290, { align: 'center' });
      }

      // ── PAGE 4: GENDER PERFORMANCE ANALYSIS ────────────────────────────────
      doc.addPage();
      {
        doc.setFillColor(37, 99, 235); doc.rect(0, 0, 210, 20, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(14); doc.setFont('helvetica', 'bold');
        doc.text(displaySchoolName, 105, 8, { align: 'center' }); doc.setFontSize(10);
        doc.text('GENDER PERFORMANCE ANALYSIS', 105, 16, { align: 'center' });

        const maleSummaries = summaries.filter(s => s.gender === 'male');
        const femaleSummaries = summaries.filter(s => s.gender === 'female');
        const unknownSummaries = summaries.filter(s => !s.gender || (s.gender !== 'male' && s.gender !== 'female'));

        const maleCount = maleSummaries.length;
        const femaleCount = femaleSummaries.length;
        const unknownCount = unknownSummaries.length;

        const maleAvg = maleCount > 0 ? maleSummaries.reduce((sum, s) => sum + s.avgPct, 0) / maleCount : 0;
        const femaleAvg = femaleCount > 0 ? femaleSummaries.reduce((sum, s) => sum + s.avgPct, 0) / femaleCount : 0;

        const maleGrade = maleCount > 0 ? (is844 ? overallGrade844(maleAvg) : overallGradeWithBand(maleAvg, band)) : null;
        const femaleGrade = femaleCount > 0 ? (is844 ? overallGrade844(femaleAvg) : overallGradeWithBand(femaleAvg, band)) : null;

        // Overview stats
        const gY = 28;
        doc.setFillColor(245, 247, 255); doc.rect(14, gY, 182, 28, 'F');
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0);
        doc.text(`Total Students: ${totalStudents}`, 20, gY + 8);
        doc.text(`Male: ${maleCount} (${totalStudents > 0 ? ((maleCount / totalStudents) * 100).toFixed(1) : 0}%)`, 75, gY + 8);
        doc.text(`Female: ${femaleCount} (${totalStudents > 0 ? ((femaleCount / totalStudents) * 100).toFixed(1) : 0}%)`, 130, gY + 8);
        if (unknownCount > 0) doc.text(`Gender not set: ${unknownCount}`, 20, gY + 18);
        doc.text(`Male Average: ${maleCount > 0 ? maleAvg.toFixed(1) + '%' : 'N/A'}`, 75, gY + 18);
        doc.text(`Female Average: ${femaleCount > 0 ? femaleAvg.toFixed(1) + '%' : 'N/A'}`, 130, gY + 18);

        // Visual comparison bar
        const barY = gY + 36;
        doc.setFontSize(10); doc.setFont('helvetica', 'bold');
        doc.text('AVERAGE PERFORMANCE COMPARISON', 14, barY);
        doc.setFontSize(8); doc.setFont('helvetica', 'normal');

        if (maleCount > 0) {
          doc.setFillColor(37, 99, 235); doc.rect(14, barY + 8, 8, 8, 'F');
          doc.setTextColor(0, 0, 0); doc.text(`Male (${maleCount} students): ${maleAvg.toFixed(1)}% — ${maleGrade ? (is844 ? (maleGrade as any).grade : (maleGrade as any).subLevel) : 'N/A'}`, 25, barY + 14);
          doc.setFillColor(200, 220, 255); doc.rect(14, barY + 18, 182, 6, 'F');
          doc.setFillColor(37, 99, 235); doc.rect(14, barY + 18, Math.max(1, 182 * maleAvg / 100), 6, 'F');
        }
        if (femaleCount > 0) {
          doc.setFillColor(236, 72, 153); doc.rect(14, barY + 30, 8, 8, 'F');
          doc.setTextColor(0, 0, 0); doc.text(`Female (${femaleCount} students): ${femaleAvg.toFixed(1)}% — ${femaleGrade ? (is844 ? (femaleGrade as any).grade : (femaleGrade as any).subLevel) : 'N/A'}`, 25, barY + 36);
          doc.setFillColor(255, 200, 230); doc.rect(14, barY + 40, 182, 6, 'F');
          doc.setFillColor(236, 72, 153); doc.rect(14, barY + 40, Math.max(1, 182 * femaleAvg / 100), 6, 'F');
        }

        // Gap analysis
        if (maleCount > 0 && femaleCount > 0) {
          const gap = Math.abs(maleAvg - femaleAvg);
          const leader = maleAvg >= femaleAvg ? 'Male' : 'Female';
          const gapY = barY + 55;
          doc.setFontSize(9); doc.setFont('helvetica', 'bold');
          doc.setTextColor(gap > 10 ? 220 : gap > 5 ? 249 : 22, gap > 10 ? 38 : gap > 5 ? 115 : 163, gap > 10 ? 38 : gap > 5 ? 22 : 74);
          doc.text(`Gender Gap: ${gap.toFixed(1)}% — ${leader} students lead by ${gap.toFixed(1)}%`, 14, gapY);
          doc.setTextColor(0, 0, 0); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
          if (gap > 10) doc.text('⚠ Significant gender gap detected. Consider targeted support for the lower-performing group.', 14, gapY + 7);
          else if (gap > 5) doc.text('Moderate gender gap. Monitor trends over subsequent terms.', 14, gapY + 7);
          else doc.text('Gender performance is well-balanced. Keep up the inclusive teaching approach!', 14, gapY + 7);
        }

        // Per-subject gender breakdown table
        const subjGenderY = barY + (maleCount > 0 && femaleCount > 0 ? 72 : 55);
        doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(0, 0, 0);
        doc.text('SUBJECT-WISE GENDER BREAKDOWN', 14, subjGenderY);

        const genderSubjectRows = allSubjects.map(sub => {
          const maleVals = maleSummaries.map(s => s.subjects[sub]).filter(v => v !== undefined);
          const femaleVals = femaleSummaries.map(s => s.subjects[sub]).filter(v => v !== undefined);
          const mAvg = maleVals.length ? maleVals.reduce((a, b) => a + b, 0) / maleVals.length : null;
          const fAvg = femaleVals.length ? femaleVals.reduce((a, b) => a + b, 0) / femaleVals.length : null;
          const diff = mAvg !== null && fAvg !== null ? mAvg - fAvg : null;
          const leader = diff === null ? 'N/A' : diff > 0.5 ? `M +${diff.toFixed(1)}%` : diff < -0.5 ? `F +${Math.abs(diff).toFixed(1)}%` : 'Equal';
          return [
            sub,
            mAvg !== null ? `${mAvg.toFixed(1)}%` : 'N/A',
            fAvg !== null ? `${fAvg.toFixed(1)}%` : 'N/A',
            leader,
          ];
        });

        autoTable(doc, {
          startY: subjGenderY + 6,
          head: [['Subject', 'Male Avg', 'Female Avg', 'Leader']],
          body: genderSubjectRows,
          styles: { fontSize: 8, cellPadding: 2 },
          headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 8, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [245, 247, 255] },
          didParseCell: (data: any) => {
            if (data.section === 'body' && data.column.index === 3) {
              const val = data.cell.raw as string;
              if (val.startsWith('M')) { data.cell.styles.textColor = [37, 99, 235]; data.cell.styles.fontStyle = 'bold'; }
              else if (val.startsWith('F')) { data.cell.styles.textColor = [236, 72, 153]; data.cell.styles.fontStyle = 'bold'; }
            }
          },
        });

        // Top male and female students
        const topGenderY = (doc as any).lastAutoTable.finalY + 10;
        if (maleSummaries.length > 0) {
          const topMale = maleSummaries[0];
          const topMaleGr = is844 ? overallGrade844(topMale.avgPct) : overallGradeWithBand(topMale.avgPct, band);
          doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(37, 99, 235);
          doc.text('Top Male Student:', 14, topGenderY);
          doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0);
          doc.text(`${topMale.student?.first_name} ${topMale.student?.last_name} — ${topMale.avgPct.toFixed(1)}% — ${is844 ? (topMaleGr as any).grade : (topMaleGr as any).subLevel}`, 55, topGenderY);
        }
        if (femaleSummaries.length > 0) {
          const topFemale = femaleSummaries[0];
          const topFemaleGr = is844 ? overallGrade844(topFemale.avgPct) : overallGradeWithBand(topFemale.avgPct, band);
          doc.setFontSize(9); doc.setFont('helvetica', 'bold'); doc.setTextColor(236, 72, 153);
          doc.text('Top Female Student:', 14, topGenderY + 8);
          doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0);
          doc.text(`${topFemale.student?.first_name} ${topFemale.student?.last_name} — ${topFemale.avgPct.toFixed(1)}% — ${is844 ? (topFemaleGr as any).grade : (topFemaleGr as any).subLevel}`, 55, topGenderY + 8);
        }
        if (unknownCount > 0) {
          doc.setFontSize(7); doc.setTextColor(150, 150, 150);
          doc.text(`Note: ${unknownCount} student(s) have no gender recorded and are excluded from gender analysis.`, 14, topGenderY + 20);
        }
        doc.setFontSize(7); doc.setTextColor(150, 150, 150);
        doc.text('Generated by Kimatu Analytics School Management System', 105, 290, { align: 'center' });
      }

      doc.save(`class_results_${classObj?.name}_${termObj?.name}_${termObj?.academic_year}.pdf`);
      toast.success('Class Results Summary PDF downloaded!');
    } catch (err: any) { toast.error('Failed to generate PDF: ' + err.message); console.error(err); }
    setGeneratingPDF(false);
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // BULK REPORT CARDS — Individual student report cards (multi-page PDF)
  // ═══════════════════════════════════════════════════════════════════════════════
  const downloadBulkReportCards = async () => {
    if (!selectedClass || !selectedTerm) { toast.error('Please select a class and term'); return; }
    setGeneratingBulk(true);
    try {
      const rawResults = await fetchClassResults();
      if (!rawResults || rawResults.length === 0) { toast.error('No results found'); setGeneratingBulk(false); return; }
      const classObj = classes.find(c => c.id === selectedClass);
      const band = getSchoolLevelBand(classObj);
      const isPrimary = band === 'primary';
      const is844 = band === '844';
      const allSubjects = Array.from(new Set(rawResults.map((r: any) => r.subjects?.name).filter(Boolean))) as string[];
      const summaries = buildStudentSummary(rawResults, classObj);
      const termObj = terms.find(t => t.id === selectedTerm);
      const totalStudents = summaries.length;

      // Fetch teacher signatures for this class
      let teacherSigUrl: string | null = null;
      if (classObj?.class_teacher_id) {
        const { data: teacherData } = await supabaseUntyped.from('teachers').select('signature_url').eq('id', classObj.class_teacher_id).maybeSingle();
        teacherSigUrl = teacherData?.signature_url || null;
      }
      const signatures: SignatureInfo = {
        principal_signature_url: principalSignatureUrl,
        teacher_signature_url: teacherSigUrl,
      };

      const prevAvgMap: Record<string, number | null> = {};
      for (const s of summaries) { prevAvgMap[s.studentId] = await fetchPreviousTermAvg(s.studentId, selectedTerm); }

      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const bulkBestPerSubject = computeBestPerSubject(rawResults, classObj);

      // Fetch trend data for all students
      const studentTrends: Record<string, { term: string; avg: number }[]> = {};
      for (const s of summaries) {
        const { data: allResults } = await supabaseUntyped
          .from('results').select('percentage, marks, out_of, term_id, terms(name, academic_year)')
          .eq('student_id', s.studentId)
          .order('terms(academic_year)', { ascending: true })
          .order('terms(name)', { ascending: true });
        if (allResults) {
          const termMap: Record<string, { term: string; total: number; count: number }> = {};
          allResults.forEach((r: any) => {
            const tname = r.terms?.name || ''; const year = r.terms?.academic_year || '';
            const key = `${year}-${tname}`;
            const pct = r.percentage !== undefined && r.percentage !== null ? Number(r.percentage) : (r.out_of > 0 ? (r.marks / r.out_of) * 100 : 0);
            if (!termMap[key]) termMap[key] = { term: `${tname} ${year}`, total: 0, count: 0 };
            termMap[key].total += pct; termMap[key].count++;
          });
          studentTrends[s.studentId] = Object.values(termMap).map(t => ({ term: t.term, avg: t.count > 0 ? t.total / t.count : 0 }));
        }
      }

      for (let idx = 0; idx < summaries.length; idx++) {
        const s = summaries[idx];
        if (idx > 0) doc.addPage();
        const prevAvg = prevAvgMap[s.studentId];
        const deviation = prevAvg !== null && prevAvg !== undefined ? s.avgPct - prevAvg : null;
        const isNew = deviation === null;
        const subjectEntries = Object.entries(s.subjects).filter(([k]) => !k.endsWith('_grade') && !k.endsWith('_points')) as [string, number][];
        const sortedBest = [...subjectEntries].sort((a, b) => b[1] - a[1]);
        const bestSubject = sortedBest[0]?.[0] || 'all subjects';
        const weakestSubject = sortedBest[sortedBest.length - 1]?.[0] || 'some subjects';
        const studentFullName = `${s.student?.first_name || ''} ${s.student?.last_name || ''}`;
        const aiComment = generateUniqueAIComment(studentFullName, s.avgPct, deviation, bestSubject, weakestSubject, s.position, totalStudents, isNew, classObj);

        // Header — use shared drawReportHeader for logo + school name consistency
        await drawReportHeader(doc, schoolInfo);

        // Student portrait in the top-right header (27mm ≈ 102px at 96 DPI).
        if (s.student?.photo_url) {
          try { await addStudentPhotoToPDF(doc, s.student.photo_url, 173, 2.5, 27); } catch {}
        }

        // Student info
        doc.setTextColor(0, 0, 0); doc.setFontSize(10); doc.setFont('helvetica', 'normal');
        const y = 38;
        doc.text(`Student: ${studentFullName}`, 14, y);
        doc.text(`Adm No: ${s.student?.admission_number || 'N/A'}`, 14, y + 7);
        doc.text(`Class: ${classObj?.name || 'N/A'}`, 14, y + 14);
        doc.text(`Term: ${termObj?.name || ''} ${termObj?.academic_year || ''}`, 120, y);
        doc.text(`Position: ${s.position}${s.position === 1 ? 'st' : s.position === 2 ? 'nd' : s.position === 3 ? 'rd' : 'th'} out of ${totalStudents}`, 120, y + 7);
        doc.text(`Date: ${new Date().toLocaleDateString()}`, 120, y + 14);
        doc.setDrawColor(37, 99, 235); doc.line(14, y + 20, 196, y + 20);

        // Subject rows
        const subjectRows = subjectEntries.map(([subName, pct]) => {
          let gradeLabel: string, pointsVal: string, descriptor: string;
          if (is844) { const g = overallGrade844(pct); gradeLabel = g.grade; pointsVal = String(g.points); descriptor = g.descriptor; }
          else { const g = overallGradeWithBand(pct, band); gradeLabel = g.subLevel; pointsVal = isPrimary ? '—' : String(g.points); descriptor = g.descriptor; }
          return isPrimary ? [subName, `${pct.toFixed(0)}%`, gradeLabel, descriptor] : [subName, `${pct.toFixed(0)}%`, gradeLabel, pointsVal, descriptor];
        });

        autoTable(doc, { startY: y + 25, head: [isPrimary ? ['Subject', 'Percentage', is844 ? '8-4-4 Grade' : 'CBE Grade', 'Descriptor'] : ['Subject', 'Percentage', is844 ? '8-4-4 Grade' : 'CBE Grade', 'Points', 'Descriptor']], body: subjectRows, styles: { fontSize: 9 }, headStyles: { fillColor: [37, 99, 235], textColor: 255 }, alternateRowStyles: { fillColor: [245, 247, 255] } });

        const tableEnd = (doc as any).lastAutoTable.finalY + 8;

        // Summary
        const gr = is844 ? overallGrade844(s.avgPct) : overallGradeWithBand(s.avgPct, band);
        doc.setFillColor(245, 247, 255); doc.rect(14, tableEnd, 182, 25, 'F');
        doc.setFontSize(9); doc.setFont('helvetica', 'bold');
        doc.text(`Average: ${s.avgPct.toFixed(1)}%`, 20, tableEnd + 8);
        doc.text(`Grade: ${is844 ? (gr as any).grade : (gr as any).subLevel}`, 70, tableEnd + 8);
        doc.text(`Position: ${s.position}/${totalStudents}`, 120, tableEnd + 8);
        if (!isPrimary) doc.text(`Points: ${s.totalPoints}`, 160, tableEnd + 8);
        doc.text(`Total: ${s.totalPct.toFixed(0)}/${allSubjects.length * 100}`, 20, tableEnd + 17);
        if (!isPrimary) doc.text(`${(gr as any).descriptor}`, 70, tableEnd + 17);

        // Deviation
        let devText = 'First Term — No previous data';
        if (deviation !== null) { const arrow = deviation >= 0 ? '\u25B2' : '\u25BC'; const sign = deviation >= 0 ? '+' : ''; devText = `${arrow} ${sign}${deviation.toFixed(1)}% vs previous term`; }
        doc.setFont('helvetica', 'normal');
        if (deviation !== null && deviation >= 0) doc.setTextColor(22, 163, 74); else if (deviation !== null && deviation < 0) doc.setTextColor(220, 38, 38); else doc.setTextColor(100, 100, 100);
        doc.text(devText, 120, tableEnd + 17); doc.setTextColor(0, 0, 0);

        // Performance trend
        let trendY = tableEnd + 30;
        const trends = studentTrends[s.studentId] || [];
        if (trends.length >= 2) {
          drawTrendGraph(doc, trends, 14, trendY, 182, 50, band, is844);
          trendY += 55;
        }

        // Achievements
        const bulkStudentBests = bulkBestPerSubject.filter(b => b.studentId === (s.student?.id || s.studentId));
        let bulkAchievementY = trendY;
        if (bulkStudentBests.length > 0) {
          doc.setFillColor(254, 249, 195); doc.rect(14, bulkAchievementY, 182, 6 + bulkStudentBests.length * 6, 'F');
          doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(202, 138, 4);
          doc.text('ACHIEVEMENT:', 18, bulkAchievementY + 5); doc.setFont('helvetica', 'normal'); doc.setTextColor(0, 0, 0);
          bulkStudentBests.forEach((b, bi) => { const pts = b.points !== null ? ` (${b.points} pts)` : ''; doc.text(`🏆 Best in ${b.subjectName}: ${b.percentage}% — ${b.gradeLabel}${pts}`, 18, bulkAchievementY + 11 + bi * 6); });
          bulkAchievementY += 6 + bulkStudentBests.length * 6 + 4;
        }

        // AI Comment
        const commentY = bulkAchievementY + 2;
        doc.setFillColor(254, 252, 232); doc.rect(14, commentY, 182, 32, 'F');
        doc.setFontSize(9); doc.setFont('helvetica', 'bold');
        doc.text("Class Teacher's Comment:", 18, commentY + 7); doc.setFont('helvetica', 'italic'); doc.setFontSize(8);
        const commentLines = doc.splitTextToSize(aiComment, 170); doc.text(commentLines, 18, commentY + 14);

        // Signatures
        const sigY = commentY + 42;
        addSignaturesToPDF(doc, signatures, sigY, schoolInfo);

        doc.setFontSize(7); doc.setTextColor(150, 150, 150);
        doc.text(`Page ${idx + 1} of ${totalStudents} | Kimatu Analytics School Management System`, 105, 290, { align: 'center' });
      }

      doc.save(`bulk_report_cards_${classObj?.name}_${termObj?.name}_${termObj?.academic_year}.pdf`);
      toast.success(`Bulk report cards generated for ${totalStudents} students!`);
    } catch (err: any) { toast.error('Failed to generate bulk report cards: ' + err.message); console.error(err); }
    setGeneratingBulk(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#111111]">Results</h1>
        <p className="text-sm text-[#666666]">View and download class results with analysis</p>
      </div>

      <div className="bg-white rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
        <h2 className="text-lg font-semibold text-[#111111] mb-4 flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-600" /> Generate Reports
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-[#666666] mb-1">Select Class</label>
            <select value={selectedClass} onChange={e => setSelectedClass(e.target.value)} className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] bg-white">
              <option value="">-- Select Class --</option>
              {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#666666] mb-1">Select Term</label>
            <select value={selectedTerm} onChange={e => setSelectedTerm(e.target.value)} className="w-full px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2563EB] bg-white">
              <option value="">-- Select Term --</option>
              {terms.map(t => <option key={t.id} value={t.id}>{t.name} {t.academic_year}</option>)}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button onClick={downloadClassResultsPDF} disabled={generatingPDF || !selectedClass || !selectedTerm}
            className="flex items-center gap-2 bg-[#2563EB] text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-[#1d4ed8] disabled:opacity-50 transition-colors">
            {generatingPDF ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {generatingPDF ? 'Generating...' : 'Download Class Results PDF'}
          </button>
          <button onClick={downloadBulkReportCards} disabled={generatingBulk || !selectedClass || !selectedTerm}
            className="flex items-center gap-2 bg-green-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors">
            {generatingBulk ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {generatingBulk ? 'Generating...' : 'Bulk Report Cards (All Students)'}
          </button>
          <button onClick={publishResults} disabled={publishing || !selectedClass || !selectedTerm}
            className="flex items-center gap-2 bg-purple-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors">
            {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {publishing ? 'Publishing...' : 'Publish & Notify'}
          </button>
        </div>
        <p className="text-xs text-[#999] mt-2">
          <strong>Class Results PDF</strong> = Class summary with grade distribution, subject analysis &amp; student table (NO individual report cards).<br />
          <strong>Bulk Report Cards</strong> = Individual report card for EACH student with AI comments, signatures &amp; trend graphs.
        </p>
      </div>

      {bestPerSubjectList.length > 0 && (
        <div className="bg-white rounded-2xl p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)]">
          <div className="flex items-center gap-2 mb-4">
            <Trophy className="w-5 h-5 text-yellow-500" />
            <h2 className="text-lg font-semibold text-[#111111]">Best Student Per Subject</h2>
            <span className="text-xs text-gray-400 ml-auto">{classes.find(c => c.id === selectedClass)?.name} — {terms.find(t => t.id === selectedTerm)?.name} {terms.find(t => t.id === selectedTerm)?.academic_year}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {bestPerSubjectList.map((b, i) => (
              <div key={i} className="flex items-start gap-3 p-3 bg-yellow-50 border border-yellow-100 rounded-xl">
                <span className="text-xl mt-0.5">🏆</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-yellow-700 uppercase tracking-wide truncate">{b.subjectName}</p>
                  <p className="text-sm font-medium text-[#111111] truncate">{b.studentName}</p>
                  <p className="text-xs text-green-700 font-bold">{b.percentage}% — {b.gradeLabel}{b.points !== null ? ` (${b.points} pts)` : ''}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input type="text" placeholder="Search by student or subject..." value={search} onChange={e => setSearch(e.target.value)}
          className="w-full pl-11 pr-4 py-3 bg-white rounded-2xl text-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#2563EB] shadow-[2px_2px_0px_0px_rgba(0,0,0,0.05)]" />
      </div>

      <div className="bg-white rounded-2xl shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse results-table">
            <thead>
              <tr className="bg-[#2563EB] text-white">
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">Student</th>
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">Learning Area</th>
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">Marks</th>
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">Grade</th>
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">Points</th>
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">DEV</th>
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">Status</th>
                <th className="text-left text-xs font-semibold uppercase px-4 py-3 border border-blue-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="text-center py-8 text-sm text-[#666666]">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-8 text-sm text-[#666666]">No results found</td></tr>
              ) : (
                filtered.map(r => {
                  const dev = r.deviation;
                  const isPrimary = getSchoolLevelBand(r.classes) === 'primary';
                  const pct = getPercentage(r);
                  // Use stored grade values directly — they are already correctly computed
                  // by the upload flow and match what report cards show.
                  // r.curriculum tells us which system: '844' or 'CBE'.
                  // For CBE: use cbc_sublevel (ME1/EE2/etc.) for junior/senior,
                  //           or cbc_grade (ME/EE/etc.) for primary (cbc_sublevel is null).
                  // For 844: use grade_844 (A/B+/etc.).
                  const is844Row = String(r.curriculum || '').toUpperCase() === '844';
                  let displayGrade = '';
                  let displayPoints: number | null = null;
                  if (is844Row) {
                    displayGrade = r.grade_844 || '';
                    displayPoints = r.points_844 != null ? Number(r.points_844) : null;
                  } else {
                    // CBE: prefer cbc_sublevel (has sub-level like ME1); fall back to cbc_grade
                    displayGrade = r.cbc_sublevel || r.cbc_grade || '';
                    // Primary has no points (cbc_points = 0 or null)
                    const pts = r.cbc_points != null ? Number(r.cbc_points) : null;
                    displayPoints = pts && pts > 0 ? pts : null;
                  }
                  return (
                    <tr key={r.id} className="border-b border-gray-200 hover:bg-blue-50 transition-colors even:bg-gray-50/50">
                      <td className="px-4 py-3 border border-gray-200">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 text-xs font-bold flex-shrink-0"><Award className="w-3.5 h-3.5" /></div>
                          <div>
                            <span className="text-sm font-semibold text-[#111111]">{r.students?.first_name} {r.students?.last_name}</span><br />
                            <span className="text-xs text-[#888888]">{r.students?.admission_number}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 border border-gray-200 text-sm font-medium text-[#333333]">{r.subjects?.name}</td>
                      <td className="px-4 py-3 border border-gray-200 text-sm font-bold text-[#111111]">{pct}%</td>
                      <td className="px-4 py-3 border border-gray-200">
                        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${gradeColor(displayGrade)}`}>{displayGrade}</span>
                      </td>
                      <td className="px-4 py-3 border border-gray-200 text-sm font-medium text-center">{isPrimary ? <span className="text-gray-400">—</span> : (displayPoints !== null ? <span className="font-bold text-blue-700">{displayPoints}</span> : <span className="text-gray-400">—</span>)}</td>
                      <td className="px-4 py-3 border border-gray-200">
                        {dev !== null && dev !== undefined ? (
                          <span className={`flex items-center gap-1 text-xs font-semibold ${Number(dev) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {Number(dev) >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {Number(dev) >= 0 ? '+' : ''}{Number(dev).toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 flex items-center gap-1"><Minus className="w-3 h-3" />NEW</span>
                        )}
                      </td>
                      <td className="px-4 py-3 border border-gray-200">
                        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${r.status === 'published' ? 'bg-green-100 text-green-700' : r.status === 'approved' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700'}`}>{r.status}</span>
                      </td>
                      <td className="px-4 py-3 border border-gray-200">
                        <div className="flex items-center gap-2">
                          <button onClick={() => openEditResult(r)} className="flex items-center gap-1 text-xs px-2 py-1 bg-amber-50 text-amber-600 rounded-lg hover:bg-amber-100 transition-colors">
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                          <button onClick={() => setDeletingResult(r)} className="flex items-center gap-1 text-xs px-2 py-1 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors">
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      {/* Edit Result Modal */}
      {editingResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Edit Result</h2>
              <button onClick={() => setEditingResult(null)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600 mb-1"><strong>Student:</strong> {editingResult.students?.first_name} {editingResult.students?.last_name}</p>
            <p className="text-sm text-gray-600 mb-4"><strong>Subject:</strong> {editingResult.subjects?.name}</p>
            <form onSubmit={handleSaveResult} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Marks Scored *</label>
                  <input type="number" value={editMarks} onChange={e => setEditMarks(e.target.value)} className="w-full px-4 py-2.5 border rounded-xl text-sm" min="0" step="0.1" required />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Out Of</label>
                  <input type="number" value={editOutOf} onChange={e => setEditOutOf(e.target.value)} className="w-full px-4 py-2.5 border rounded-xl text-sm" min="1" step="1" />
                </div>
              </div>
              {editMarks && editOutOf && (
                <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm text-blue-800">
                  <strong>Preview:</strong> {Math.round((parseFloat(editMarks) / parseFloat(editOutOf)) * 100)}% — Grade will be auto-recalculated on save
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setEditingResult(null)} className="px-6 py-2.5 border rounded-xl text-sm font-medium hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingResult} className="px-6 py-2.5 bg-[#2563EB] text-white rounded-xl text-sm font-medium hover:bg-[#1d4ed8] disabled:opacity-50 flex items-center gap-2">
                  {savingResult ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save & Recalculate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Result Confirmation Modal */}
      {deletingResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-lg">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Delete Result</h2>
                <p className="text-xs text-gray-500">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-gray-700 mb-2">
              Are you sure you want to delete the result for:
            </p>
            <p className="text-sm font-medium text-gray-900 mb-1">{deletingResult.students?.first_name} {deletingResult.students?.last_name}</p>
            <p className="text-sm text-gray-600 mb-6">Subject: {deletingResult.subjects?.name}</p>
            <div className="flex gap-3">
              <button onClick={() => setDeletingResult(null)} className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50">Cancel</button>
              <button onClick={handleDeleteResult} disabled={deletingResultLoading} className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2">
                {deletingResultLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
