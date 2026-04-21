/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Trophy, 
  Flame, 
  Mail, 
  Plus, 
  CheckCircle2, 
  AlertCircle, 
  Sword, 
  ScrollText,
  X,
  Sparkles,
  ArrowRight,
  ClipboardCheck,
  Zap,
  Library,
  RefreshCw,
  LogOut,
  Settings
} from 'lucide-react';
import { GoogleGenAI } from "@google/genai";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  updateDoc, 
  deleteDoc, 
  doc, 
  setDoc, 
  getDoc,
  writeBatch,
  where,
  orderBy
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();

// Types
interface Assignment {
  id: string;
  title: string;
  subject: string;
  priority: number; // 1-5 (Threat)
  workload: number; // 1-5 (Size/Hours)
  points: number;
  status: 'todo' | 'completed';
  dueDate: string;
  source?: 'manual' | 'canvas';
  externalId?: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [points, setPoints] = useState(0);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [showEmailTool, setShowEmailTool] = useState(false);
  const [selectedForEmail, setSelectedForEmail] = useState<Assignment | null>(null);
  const [generatedEmail, setGeneratedEmail] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  
  // Canvas State
  const [canvasUrl, setCanvasUrl] = useState('https://canvas.instructure.com');
  const [manualToken, setManualToken] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [showCanvasSetup, setShowCanvasSetup] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  // Tactical Strategist state
  const [analyzingTactics, setAnalyzingTactics] = useState(false);
  const [recommendedId, setRecommendedId] = useState<string | null>(null);
  const [tacticalAdvice, setTacticalAdvice] = useState<string | null>(null);

  // Handle Auth
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
  }, []);

  // Fetch Data from Firestore
  useEffect(() => {
    if (!user) {
      setAssignments([]);
      setPoints(0);
      return;
    }

    // Subscribe to Quests
    const questsQuery = query(collection(db, `users/${user.uid}/quests`));
    const unsubscribeQuests = onSnapshot(questsQuery, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Assignment));
      setAssignments(docs);
      
      // Calculate total points from completed assignments
      const totalPoints = docs
        .filter(a => a.status === 'completed')
        .reduce((sum, a) => sum + (a.points || 0), 0);
      setPoints(totalPoints);
    });

    // Subscribe to Config
    const configDoc = doc(db, `users/${user.uid}/config/main`);
    const unsubscribeConfig = onSnapshot(configDoc, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data.canvasUrl) setCanvasUrl(data.canvasUrl);
      }
    });

    return () => {
      unsubscribeQuests();
      unsubscribeConfig();
    };
  }, [user]);

  const handleManualTokenSync = async () => {
    if (!user || !manualToken || !canvasUrl) return;
    setIsSyncing(true);
    setLastSyncError(null);
    try {
      const response = await fetch('/api/canvas/sync-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: manualToken, canvasUrl })
      });
      
      const contentType = response.headers.get('content-type');
      let data;
      
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        // Not JSON - likely an HTML error page or proxy error
        const text = await response.text();
        console.error('Non-JSON response received:', text.substring(0, 500));
        throw new Error(`Server returned unexpected response (Status: ${response.status}). This often happens if the session timed out or the domain is blocked.`);
      }

      if (!response.ok) throw new Error(data?.error || `Sync failed (Status: ${response.status})`);
      
      const { assignments: canvasQuests } = data;
      await processCanvasQuests(canvasQuests);
      // Auto-trigger AI Analysis after successful manual sync
      setTimeout(() => runTacticalAnalysis(), 500);
    } catch (error: any) {
      console.error('Manual sync error detailed:', error);
      setLastSyncError(error.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const processCanvasQuests = async (canvasQuests: any[]) => {
    if (!user) return;
    const batch = writeBatch(db);
    const now = new Date();

    canvasQuests.forEach((cq: any) => {
      const questId = `canvas_${cq.id}`;
      const questRef = doc(db, `users/${user.uid}/quests/${questId}`);
      
      const due = cq.due_at ? new Date(cq.due_at) : null;
      // Robust completion check: check has_submitted_submissions OR existence of a submission object with points/grade
      const isCompleted = cq.has_submitted_submissions || (cq.submission && (cq.submission.workflow_state === 'graded' || cq.submission.workflow_state === 'submitted'));
      const isOverdue = due && due < now && !isCompleted;

      batch.set(questRef, {
        title: cq.name,
        subject: cq.courseName || 'Imported',
        priority: isOverdue ? 5 : 3, // Overdue becomes "Critical Threat" (5)
        workload: 3, 
        points: 300,
        status: isCompleted ? 'completed' : 'todo',
        dueDate: cq.due_at ? cq.due_at.split('T')[0] : 'No Due Date',
        source: 'canvas',
        externalId: String(cq.id)
      }, { merge: true });
    });

    await batch.commit();
    setShowCanvasSetup(false);
    setManualToken('');
  };

  // Sorting logic
  const sortedAssignments = useMemo(() => {
    return [...assignments].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'todo' ? -1 : 1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    });
  }, [assignments]);

  // Derived state
  const level = Math.floor(points / 500) + 1;
  const progressToNextLevel = (points % 500) / 5; // 0-100

  // Points system: (Difficulty + Workload) * 50
  const addAssignment = async (title: string, subject: string, priority: number, workload: number, dueDate: string) => {
    if (!user) return;
    const pointsValue = (priority + workload) * 50;
    try {
      await addDoc(collection(db, `users/${user.uid}/quests`), {
        title,
        subject,
        priority,
        workload,
        points: pointsValue,
        status: 'todo',
        dueDate: dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      });
      setIsAdding(false);
    } catch (e) {
      console.error('Error adding assignment:', e);
    }
  };

  const completeAssignment = async (id: string, assignmentPoints: number) => {
    if (!user) return;
    try {
      const questRef = doc(db, `users/${user.uid}/quests/${id}`);
      await updateDoc(questRef, { status: 'completed' });
      if (recommendedId === id) {
        setRecommendedId(null);
        setTacticalAdvice(null);
      }
    } catch (e) {
      console.error('Error completing assignment:', e);
    }
  };

  const deleteAssignment = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, `users/${user.uid}/quests/${id}`));
      if (recommendedId === id) {
        setRecommendedId(null);
        setTacticalAdvice(null);
      }
    } catch (e) {
      console.error('Error deleting assignment:', e);
    }
  };

  const runTacticalAnalysis = async () => {
    const activeQuests = assignments.filter(a => a.status === 'todo');
    if (activeQuests.length === 0) return;

    setAnalyzingTactics(true);
    setTacticalAdvice("Running scenario simulations...");
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      const prompt = `You are a Tactical Recovery Strategist. Analyze these student assignments and pick the SINGLE most important one to focus on RIGHT NOW.
      Logic: Prioritize based on proximity of due date vs workload size vs priority level. 
      Small tasks due very soon are good "quick wins". Large tasks due soon are "critical threats".
      
      Active Assignments:
      ${activeQuests.map((a: any) => `- ID: ${a.id}, Title: ${a.title}, Due: ${a.dueDate}, Workload (1-5): ${a.workload}, Priority (1-5): ${a.priority}`).join('\n')}
      
      Respond in strictly this JSON format:
      {
        "recommendedId": "the-id",
        "reason": "15-word max explanation of why this is the priority"
      }`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });
      
      const result = JSON.parse(response.text || "{}");
      
      if (result.recommendedId) {
        setRecommendedId(result.recommendedId);
        setTacticalAdvice(result.reason);
      }
    } catch (error) {
      console.error(error);
      setTacticalAdvice("Tactical link severed. Try again later.");
    } finally {
      setAnalyzingTactics(false);
    }
  };

  const generateEmail = async (assignment: Assignment) => {
    setIsGenerating(true);
    setShowEmailTool(true);
    setSelectedForEmail(assignment);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
      const prompt = `You are a helpful academic advisor. Write a polite, professional, and concise email template for a student to ask their teacher for an extension on the following assignment. 
        Assignment: ${assignment.title}
        Subject: ${assignment.subject}
        Priority Level: ${assignment.priority}/5
        
        The email should explain the student was absent and request a specific number of extra days (e.g. 3-5). 
        Format the output as a ready-to-copy email with placeholders like [Teacher Name] and [Student Name]. 
        Keep it brief and encouraging. No giant blocks of text.`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });
      
      setGeneratedEmail(response.text || "Could not generate email. Please try again.");
    } catch (error) {
      console.error(error);
      setGeneratedEmail("Error connecting to the Diplomacy Center. Check your keys or connection.");
    } finally {
      setIsGenerating(false);
    }
  };

  const [loginError, setLoginError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setLoginError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e: any) {
      if (e.code === 'auth/popup-closed-by-user') {
        console.log('Login cancelled by user');
      } else if (e.code === 'auth/unauthorized-domain') {
        setLoginError('This domain is not authorized in Firebase. Please add this URL to your Firebase Console > Auth > Settings > Authorized Domains.');
        console.error('Unauthorized domain:', window.location.hostname);
      } else {
        setLoginError('Initialization failed. Check your connection or security keys.');
        console.error('Login error:', e);
      }
    }
  };

  // Diplomacy Overlay
  if (!user) {
    return (
      <div className="min-h-screen bg-bento-bg flex items-center justify-center p-8 relative overflow-hidden">
        {/* Animated Background blobs */}
        <div className="absolute top-[-10%] left-[-5%] w-[60%] h-[60%] bg-bento-pink/10 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[60%] h-[60%] bg-bento-blue/10 blur-[120px] rounded-full animate-pulse" style={{ animationDelay: '2s' }} />

        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center space-y-10 bg-white/90 backdrop-blur-2xl border-2 border-white p-14 rounded-[3.5rem] shadow-2xl relative z-10"
        >
          <div className="space-y-6">
            <div className="mx-auto w-28 h-28 bg-white shadow-2xl rounded-[2.5rem] flex items-center justify-center border border-slate-50">
              <Trophy size={56} className="text-bento-orange" />
            </div>
            <div className="space-y-2">
              <h1 className="text-5xl font-black tracking-tighter text-slate-900 leading-none">REBOUND</h1>
              <p className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400">Academic Recovery Protocol</p>
            </div>
            <p className="text-sm font-bold text-slate-500 leading-relaxed px-2 italic">
              "The ultimate tactical re-entry system for students reclaiming their academic momentum."
            </p>
          </div>
          
          <div className="space-y-4">
            {loginError && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="p-4 bg-red-50 border border-red-100 rounded-2xl text-[10px] font-bold text-red-500 uppercase tracking-wider leading-relaxed"
              >
                <div className="flex items-center gap-2 mb-1 justify-center">
                  <AlertCircle size={14} /> Critical Error
                </div>
                {loginError}
              </motion.div>
            )}

            <button 
              onClick={handleSignIn}
              className="w-full bg-slate-900 text-white py-6 rounded-[1.8rem] font-black uppercase text-xs tracking-[0.25em] shadow-2xl shadow-slate-900/30 hover:scale-[1.03] transition-all active:scale-95 flex items-center justify-center gap-4 group"
            >
              Initialize Identity <ArrowRight className="group-hover:translate-x-2 transition-transform" />
            </button>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-300">Secure Cloud Sync Included</p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bento-bg text-slate-800 font-sans selection:bg-bento-blue selection:text-white relative overflow-x-hidden">
      {/* Eye-catching background visuals */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-5%] w-[40%] h-[40%] bg-bento-pink/10 blur-[120px] rounded-full animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[40%] h-[40%] bg-bento-blue/10 blur-[120px] rounded-full animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-[30%] right-[10%] w-[20%] h-[20%] bg-bento-green/5 blur-[80px] rounded-full" />
      </div>

      <header className="relative z-10 px-8 py-8 flex flex-col md:flex-row justify-between items-center bg-white/40 backdrop-blur-md border-b border-white/40 gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-white rounded-2xl shadow-sm border border-slate-100">
             <Trophy size={28} className="text-bento-orange" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 leading-none">
              REBOUND <span className="text-slate-300 font-normal ml-2">v2.0</span>
            </h1>
            <p className="text-[10px] uppercase font-black tracking-[0.2em] text-slate-400 mt-1">
              Recovery Protocol <span className="text-bento-green ml-1">{assignments.filter(a => a.status === 'completed').length} Victories</span>
            </p>
          </div>
        </div>
        
        <div className="flex flex-wrap justify-center items-center gap-4">
          <div className="flex gap-2">
            <div className="px-4 py-2 bg-white border border-slate-100 rounded-2xl shadow-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-bento-green animate-ping" />
              <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">XP</span>
              <span className="text-sm font-black text-slate-900">{points}</span>
            </div>
            <div className="px-4 py-2 bg-white border border-slate-100 rounded-2xl shadow-sm flex items-center gap-2">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">LVL</span>
              <span className="text-sm font-black text-slate-900">{level}</span>
            </div>
          </div>

          <div className="h-10 w-px bg-slate-200" />

          <div className="flex items-center gap-3">
             <button 
               onClick={() => setShowCanvasSetup(true)}
               className="p-3 bg-white border border-slate-100 rounded-2xl shadow-sm text-slate-500 hover:text-bento-blue transition-colors group relative"
               title="Link Canvas"
             >
                <Library size={20} />
                {assignments.some(a => a.source === 'canvas') && <span className="absolute top-1 right-1 w-2 h-2 bg-bento-blue rounded-full" />}
             </button>
             
             {user && (
               <div className="flex items-center gap-3 pl-2">
                  <img 
                    src={user.photoURL || `https://picsum.photos/seed/${user.uid}/100/100`} 
                    alt="User" 
                    className="w-10 h-10 rounded-2xl border-2 border-white shadow-md"
                    referrerPolicy="no-referrer"
                  />
                  <button 
                    onClick={() => signOut(auth)}
                    className="p-3 bg-slate-900 text-white rounded-2xl hover:bg-slate-800 transition-colors shadow-lg shadow-slate-900/10"
                  >
                    <LogOut size={18} />
                  </button>
               </div>
             )}
          </div>
        </div>
      </header>

      <main className="relative z-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 grid-rows-auto gap-6 p-8 max-w-[1400px] mx-auto">
        {/* Main Quest: Active Assignments (Spans 2x2) */}
        <section className="col-span-1 md:col-span-2 row-span-2 bg-white/60 backdrop-blur-md border border-white/80 rounded-[2.5rem] p-8 flex flex-col relative shadow-xl shadow-slate-200/50 group">
          <div className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-4">
               <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 flex items-center gap-2">
                 <Sword size={14} className="text-bento-pink" />
                 Active Quests
               </h2>
               {assignments.filter(a => a.status === 'todo').length > 0 && (
                 <button 
                   onClick={runTacticalAnalysis}
                   className={`flex items-center gap-2 px-3 py-1 bg-bento-blue/10 border border-bento-blue/30 rounded-full text-[10px] font-black uppercase tracking-[0.15em] text-bento-blue hover:bg-bento-blue/20 transition-all shadow-sm ${
                      assignments.filter(a => a.priority === 5 && a.status === 'todo').length > 0 && !recommendedId 
                      ? 'animate-pulse ring-2 ring-bento-blue/50' 
                      : ''
                    } ${analyzingTactics ? 'animate-pulse opacity-50' : ''}`}
                 >
                   Tactical Scan
                 </button>
               )}
            </div>
            <button 
              onClick={() => setIsAdding(true)}
              className="bg-bento-pink text-white px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-bento-pink/20 hover:scale-105 transition-transform active:scale-95"
            >
              Add Command
            </button>
          </div>

          {tacticalAdvice && (
            <motion.div 
              initial={{ height: 0, opacity: 0, scale: 0.95 }}
              animate={{ height: 'auto', opacity: 1, scale: 1 }}
              className="mb-6 p-4 bg-bento-blue/5 border border-bento-blue/10 rounded-2xl flex items-center gap-3"
            >
              <div className="p-2 bg-bento-blue/10 rounded-xl">
                 <Sparkles size={16} className="text-bento-blue shrink-0" />
              </div>
              <p className="text-[11px] font-bold text-slate-600 italic uppercase leading-tight tracking-tight">{tacticalAdvice}</p>
            </motion.div>
          )}

          <div className="flex-grow space-y-4 overflow-y-auto pr-2 custom-scrollbar max-h-[600px]">
            <AnimatePresence mode="popLayout">
              {isAdding && (
                <AssignmentForm onAdd={addAssignment} onCancel={() => setIsAdding(false)} />
              )}
              {assignments.filter(a => a.status === 'todo').length === 0 && !isAdding ? (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50 py-24">
                   <div className="p-6 bg-slate-50 rounded-[2rem]">
                      <Sword size={64} className="text-slate-300" />
                   </div>
                   <p className="text-sm font-black uppercase tracking-widest italic text-slate-400">All sectors clear.</p>
                </div>
              ) : (
                assignments.filter(a => a.status === 'todo')
                  .sort((a, b) => b.priority - a.priority || new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
                  .map((assignment) => (
                    <QuestCard 
                      key={assignment.id} 
                      assignment={assignment} 
                      onComplete={completeAssignment}
                      onEmail={generateEmail}
                      onDelete={deleteAssignment}
                      isRecommended={recommendedId === assignment.id}
                    />
                  ))
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* Side Quests: Quick Wins (Spans 1x2) */}
        <section className="col-span-1 row-span-2 bg-white/40 backdrop-blur-md border border-white/60 rounded-[2.5rem] p-8 flex flex-col shadow-lg shadow-slate-100/30">
          <div className="text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-8 flex items-center gap-2">
            <Trophy size={14} className="text-bento-green" />
            Hall of Victories
          </div>
          <div className="space-y-3 overflow-y-auto flex-grow max-h-[600px] pr-1">
            {assignments.filter(a => a.status === 'completed').length === 0 ? (
              <div className="py-20 text-center flex flex-col items-center justify-center space-y-4">
                 <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center">
                    <CheckCircle2 size={24} className="text-slate-200" />
                 </div>
                 <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Awaiting victories...</p>
              </div>
            ) : (
              assignments.filter(a => a.status === 'completed').map((assignment) => (
                <div key={assignment.id} className="p-4 bg-white/60 border border-slate-100 rounded-2xl flex justify-between items-center group shadow-sm hover:shadow-md transition-shadow">
                  <div className="min-w-0">
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{assignment.subject}</span>
                    <h4 className="text-xs font-black text-slate-800 truncate">{assignment.title}</h4>
                  </div>
                  <span className="text-[10px] font-black text-bento-green whitespace-nowrap bg-bento-green/5 px-2 py-1 rounded-lg">+{assignment.points}</span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Recovery Status: Mini-Map (Spans 1x1) */}
        <section className="col-span-1 row-span-1 bg-white border border-slate-50 rounded-[2.5rem] p-8 flex flex-col justify-center shadow-lg shadow-slate-100/50">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Recovery Status</div>
          <div className="text-4xl font-black text-slate-900 tracking-tighter">Stage {level}</div>
          <div className="text-[9px] text-bento-green mt-1 uppercase font-black tracking-widest">Optimized Protocol</div>
          <div className="mt-8 space-y-2">
            <div className="flex justify-between items-end text-[10px] font-black uppercase tracking-widest text-slate-400">
               <span>Efficiency</span>
               <span className="text-slate-900">{Math.round(progressToNextLevel)}%</span>
            </div>
            <div className="w-full h-3 bg-slate-50 rounded-full overflow-hidden p-1 border border-slate-100">
               <div 
                 className="h-full bg-gradient-to-r from-bento-green to-emerald-400 rounded-full transition-all duration-700 ease-out" 
                 style={{ width: `${progressToNextLevel}%` }}
               />
            </div>
          </div>
        </section>

        {/* The Negotiator: NPC Comms (Spans 2x1) */}
        <section className="col-span-1 md:col-span-2 row-span-1 bg-slate-900 rounded-[2.5rem] p-8 flex flex-col shadow-2xl shadow-slate-900/40 relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:rotate-12 transition-transform">
             <Mail size={120} className="text-white" />
          </div>
          <div className="flex justify-between items-start mb-6 relative z-10">
            <div className="space-y-1">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Social Engineering</div>
              <h3 className="text-lg font-black text-white italic uppercase tracking-tight">The Negotiator</h3>
            </div>
            <div className="px-3 py-1 bg-bento-blue rounded-full text-[8px] font-black text-white uppercase tracking-widest">Dialogue Active</div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 relative z-10">
             <div className="bg-white/5 border border-dashed border-bento-blue/40 p-5 rounded-3xl group/card">
                <div className="text-xs font-black text-white flex items-center gap-2">
                   <Mail size={14} className="text-bento-blue" />
                   Extension Request
                </div>
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed opacity-60">Automatically drafted via AI. Click the letter icon on tasks to trigger negotiation protocol.</p>
             </div>
             <div className="bg-white/5 p-5 rounded-3xl border border-white/5 hover:border-bento-blue/30 transition-colors cursor-help group/card">
                <div className="text-xs font-black text-white flex items-center gap-2">
                   <AlertCircle size={14} className="text-bento-orange" />
                   Office Hours Sync
                </div>
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed opacity-60">Request a status check or help briefing to ensure assignment alignment and XP gains.</p>
             </div>
          </div>
        </section>

        {/* Quick Loot: Inventory (Spans 1x1) */}
        <section className="col-span-1 row-span-1 bg-white border border-slate-50 rounded-[2.5rem] p-8 flex flex-col shadow-lg shadow-slate-100/50">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-6 flex items-center justify-between">
            <span>Quick Loot</span>
            <Zap size={14} className="text-bento-blue" />
          </div>
          <div className="flex flex-wrap gap-2">
            {['Canvas', 'Gmail', 'Slides', 'GPT', 'Notion'].map(tag => (
              <span key={tag} className="px-3 py-1.5 bg-slate-50 border border-slate-100 rounded-xl text-[9px] font-black text-slate-500 uppercase tracking-widest hover:bg-white hover:shadow-sm transition-all cursor-pointer">
                {tag}
              </span>
            ))}
          </div>
        </section>

        {/* Stamina: Placeholder (Spans 1x1) */}
        <section className="col-span-1 row-span-1 bg-gradient-to-br from-bento-orange to-amber-500 rounded-[2.5rem] p-8 flex flex-col justify-center items-center text-center shadow-xl shadow-orange-200/50">
            <div className="text-[10px] font-black uppercase tracking-widest text-white/60 mb-2 self-start">Mental Stamina</div>
            <div className="text-6xl font-black text-white tracking-tighter">84%</div>
            <div className="mt-4 px-3 py-1 bg-white/20 rounded-full text-[8px] font-black text-white uppercase tracking-widest">Stable Core</div>
        </section>
      </main>

      {/* Diplomacy Overlay */}
      <AnimatePresence>
        {showEmailTool && selectedForEmail && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setShowEmailTool(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 30 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 30 }}
              className="relative w-full max-w-2xl bg-white rounded-[3rem] overflow-hidden shadow-2xl"
            >
              <div className="p-10 space-y-8">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                     <span className="px-3 py-1 bg-bento-blue/10 rounded-full text-[9px] font-black text-bento-blue uppercase tracking-[0.2em] mb-4 inline-block">Transmission Protocol</span>
                    <h2 className="text-3xl font-black uppercase text-slate-900 tracking-tight italic">Negotiation</h2>
                  </div>
                  <button onClick={() => setShowEmailTool(false)} className="p-3 bg-slate-50 hover:bg-slate-100 rounded-2xl transition-colors">
                    <X size={24} className="text-slate-400" />
                  </button>
                </div>

                <div className="relative min-h-[350px] bg-slate-50 border border-slate-100 rounded-[2rem] p-8 font-mono text-sm overflow-y-auto shadow-inner">
                  {isGenerating ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
                      <div className="w-12 h-12 border-[6px] border-bento-blue/20 border-t-bento-blue rounded-full animate-spin" />
                      <p className="text-[10px] uppercase font-black tracking-[0.3em] text-bento-blue animate-pulse">Computing Diplomacy Response...</p>
                    </div>
                  ) : (
                    <pre className="whitespace-pre-wrap text-slate-600 leading-relaxed font-mono">
                      {generatedEmail}
                    </pre>
                  )}
                </div>

                <div className="flex items-center justify-end gap-3 pt-4">
                  <button 
                     onClick={() => {
                        navigator.clipboard.writeText(generatedEmail);
                     }}
                     className="px-10 py-5 bg-slate-900 text-white rounded-[1.5rem] font-black text-xs uppercase tracking-[0.2em] hover:scale-105 transition-transform shadow-xl shadow-slate-900/20 active:scale-95"
                  >
                    Copy Transmission
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Canvas Integration Overlay */}
      <AnimatePresence>
        {showCanvasSetup && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white rounded-[3rem] p-12 max-w-xl w-full shadow-2xl border border-white relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-rose-400 via-orange-400 to-indigo-400" />
              
              <div className="flex justify-between items-start mb-8">
                <div className="flex items-center gap-4">
                  <div className="p-4 bg-indigo-50 rounded-2xl">
                    <Library className="text-indigo-600" size={32} />
                  </div>
                  <div>
                    <h2 className="text-2xl font-black text-slate-900 tracking-tight leading-none uppercase italic">Canvas Link Protocol</h2>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Automatic Quest Import System</p>
                  </div>
                </div>
                <button onClick={() => setShowCanvasSetup(false)} className="p-3 hover:bg-slate-50 rounded-2xl transition-colors">
                  <X size={24} className="text-slate-400" />
                </button>
              </div>

              <div className="space-y-8">
                <div className="space-y-6">
                  <div className="space-y-2">
                     <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest pl-1">Institution Canvas URL</label>
                     <div className="relative">
                        <input 
                          type="text" 
                          placeholder="https://canvas.instructure.com"
                          value={canvasUrl}
                          onChange={(e) => {
                            setCanvasUrl(e.target.value);
                            setLastSyncError(null);
                          }}
                          className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-6 py-5 text-sm font-bold focus:outline-none focus:border-indigo-400 focus:bg-white text-slate-800"
                        />
                        <Settings className="absolute right-6 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
                     </div>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest pl-1">Canvas Access Token</label>
                        <input 
                          type="password" 
                          placeholder="Paste your token here..."
                          value={manualToken}
                          onChange={(e) => {
                            setManualToken(e.target.value);
                            setLastSyncError(null);
                          }}
                          className={`w-full bg-slate-50 border rounded-2xl px-6 py-5 text-sm font-bold focus:outline-none focus:bg-white text-slate-800 transition-colors ${lastSyncError ? 'border-rose-400' : 'border-slate-100 focus:border-indigo-400'}`}
                        />
                    </div>

                    {lastSyncError && (
                      <div className="p-4 bg-rose-50 border border-rose-100 rounded-2xl space-y-2">
                        <div className="flex items-center gap-2 text-rose-600 font-black text-[10px] uppercase tracking-widest">
                           <AlertCircle size={14} /> 
                           Failed: {lastSyncError}
                        </div>
                        {lastSyncError.toLowerCase().includes('token') && (
                          <div className="text-[9px] text-slate-500 font-bold leading-tight">
                            • Ensure the token is copied exactly without spaces.<br/>
                            • Check if the token has expired in your Canvas settings.<br/>
                            • Ensure it is a "Manual Token" from Approved Integrations.
                          </div>
                        )}
                        {lastSyncError.toLowerCase().includes('invalid canvas url') && (
                          <div className="text-[9px] text-slate-500 font-bold leading-tight">
                            • URL should look like: https://school.instructure.com<br/>
                            • Ensure there are no typos in the domain name.
                          </div>
                        )}
                      </div>
                    )}

                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tight px-1">
                      Get yours at <span className="text-indigo-500">Settings &gt; Approved Integrations &gt; + New Token</span> in Canvas.
                    </p>
                    <button 
                      onClick={handleManualTokenSync}
                      disabled={isSyncing || !manualToken}
                      className="w-full bg-slate-900 text-white py-6 rounded-[1.8rem] font-black uppercase text-xs tracking-[0.2em] shadow-xl shadow-slate-900/20 hover:scale-[1.02] transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-3"
                    >
                      {isSyncing ? <RefreshCw className="animate-spin" size={18} /> : <Zap size={18} />}
                      Sync Quests (Manual)
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Subcomponents
const getSubjectTheme = (subject: string) => {
  const s = subject.toLowerCase();
  if (s.includes('math')) return { color: '#3B82F6', bg: 'bg-blue-500/10', text: 'text-blue-600', border: 'border-blue-200' };
  if (s.includes('sci')) return { color: '#10B981', bg: 'bg-emerald-500/10', text: 'text-emerald-600', border: 'border-emerald-200' };
  if (s.includes('hist') || s.includes('social')) return { color: '#F59E0B', bg: 'bg-amber-500/10', text: 'text-amber-600', border: 'border-amber-200' };
  if (s.includes('eng') || s.includes('lit')) return { color: '#8B5CF6', bg: 'bg-purple-500/10', text: 'text-purple-600', border: 'border-purple-200' };
  if (s.includes('art') || s.includes('design')) return { color: '#EC4899', bg: 'bg-pink-500/10', text: 'text-pink-600', border: 'border-pink-200' };
  if (s.includes('comp') || s.includes('tech')) return { color: '#06B6D4', bg: 'bg-cyan-500/10', text: 'text-cyan-600', border: 'border-cyan-200' };
  return { color: '#64748B', bg: 'bg-slate-500/10', text: 'text-slate-600', border: 'border-slate-200' };
};

interface QuestCardProps {
  assignment: Assignment;
  onComplete: (id: string, p: number) => void;
  onEmail: (a: Assignment) => Promise<void> | void;
  onDelete: (id: string) => void;
  isRecommended?: boolean;
  key?: string | number;
}

function QuestCard({ 
  assignment, 
  onComplete, 
  onEmail,
  onDelete,
  isRecommended
}: QuestCardProps) {
  const theme = getSubjectTheme(assignment.subject);

  return (
    <motion.div 
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className={`relative p-6 rounded-[2rem] flex flex-col md:flex-row justify-between items-start md:items-center gap-6 transition-all border-2 ${
        isRecommended 
          ? 'bg-white border-bento-blue shadow-[0_20px_40px_rgba(14,165,233,0.15)] z-10' 
          : `bg-white/80 ${theme.border} hover:border-slate-300 hover:bg-white shadow-sm hover:shadow-md`
      }`}
    >
      <div className="absolute left-0 top-1/4 bottom-1/4 w-1 rounded-r-full" style={{ backgroundColor: theme.color }} />
      
      <div className="space-y-2 min-w-0 flex-1 pl-2">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {isRecommended && (
            <span className="text-[8px] font-black px-2 py-1 rounded-lg bg-bento-blue text-white uppercase tracking-widest flex items-center gap-1 shadow-sm">
              <Sparkles size={10} /> Optimal Target
            </span>
          )}
          <span className={`text-[8px] font-black px-2 py-1 rounded-lg uppercase tracking-widest ${
            assignment.priority >= 4 ? 'bg-rose-500 text-white' : 
            assignment.priority === 3 ? 'bg-amber-500 text-white' : 'bg-emerald-500 text-white'
          }`}>
            {assignment.priority >= 4 ? 'CRITICAL THREAT' : assignment.priority === 3 ? 'MAJOR QUEST' : 'SIDE QUEST'}
          </span>
          <span className={`text-[10px] font-black px-2 py-1 rounded-lg uppercase tracking-widest ${theme.bg} ${theme.text}`}>
            {assignment.subject}
          </span>
        </div>
        <h3 className="text-xl font-black text-slate-900 tracking-tight leading-tight">
          {assignment.title}
        </h3>
        <div className="flex flex-wrap items-center gap-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">
           <span className="flex items-center gap-1 text-bento-green bg-bento-green/5 px-2 py-1 rounded-md">+{assignment.points} EXP</span>
           <span className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md"><AlertCircle size={12} className={new Date(assignment.dueDate) < new Date() ? 'text-rose-500' : 'text-slate-300'} /> Deadline: {assignment.dueDate}</span>
           <span className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md"><Zap size={12} className="text-slate-300" /> W-Load: {assignment.workload}</span>
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <button 
          onClick={() => onEmail(assignment)}
          className="p-4 bg-slate-50 hover:bg-bento-blue hover:text-white text-slate-400 rounded-2xl transition-all shadow-sm active:scale-90"
        >
          <Mail size={18} />
        </button>
        <button 
          onClick={() => onDelete(assignment.id)}
          className="p-4 bg-slate-50 hover:bg-rose-500 hover:text-white text-slate-400 rounded-2xl transition-all shadow-sm active:scale-90"
        >
          <X size={18} />
        </button>
        <button 
          onClick={() => onComplete(assignment.id, assignment.points)}
          className="bg-slate-900 group hover:bg-slate-800 px-8 py-4 rounded-[1.2rem] text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-slate-900/20 hover:scale-105 transition-all active:scale-95"
        >
          Finalize <ArrowRight size={14} className="inline ml-2 group-hover:translate-x-1 transition-transform" />
        </button>
      </div>
    </motion.div>
  );
}

function AssignmentForm({ onAdd, onCancel }: { onAdd: (t: string, s: string, p: number, w: number, d: string) => void, onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [priority, setPriority] = useState(1);
  const [workload, setWorkload] = useState(3);
  const [dueDate, setDueDate] = useState(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);

  return (
    <motion.div 
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="p-8 bg-white border-2 border-slate-100 rounded-[2.5rem] space-y-8 shadow-2xl relative z-20"
    >
      <div className="flex items-center gap-4 border-b border-slate-50 pb-6">
         <div className="p-3 bg-bento-pink/10 rounded-2xl">
            <Plus size={24} className="text-bento-pink" />
         </div>
         <h3 className="text-xl font-black text-slate-900 uppercase italic tracking-tight">New Quest Deployment</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="space-y-3 md:col-span-2">
          <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Mission Name</label>
          <input 
            autoFocus
            type="text" 
            placeholder="Assignment title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-6 py-4 text-sm focus:outline-none focus:border-bento-blue focus:bg-white text-slate-800 placeholder:text-slate-300 transition-all font-bold"
          />
        </div>
        <div className="space-y-3">
          <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Subject Area</label>
          <input 
            type="text" 
            placeholder="Science, Math, etc..."
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-6 py-4 text-sm focus:outline-none focus:border-bento-blue focus:bg-white text-slate-800 placeholder:text-slate-300 font-bold"
          />
        </div>
        <div className="space-y-3">
          <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Deadline</label>
          <input 
            type="date" 
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-6 py-4 text-sm focus:outline-none focus:border-bento-blue focus:bg-white text-slate-800 font-bold"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        <div className="space-y-4">
          <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-400">
            <span>Threat Rating</span>
            <span className="text-bento-pink bg-bento-pink/5 px-2 py-0.5 rounded-lg">{priority}/5</span>
          </div>
          <input 
            type="range" 
            min="1" 
            max="5" 
            value={priority}
            onChange={(e) => setPriority(parseInt(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[8px] font-black text-slate-300 uppercase tracking-widest">
             <span>Minor</span>
             <span>Crisis</span>
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-400">
            <span>Workload Volume</span>
            <span className="text-bento-blue bg-bento-blue/5 px-2 py-0.5 rounded-lg">{workload}/5</span>
          </div>
          <input 
            type="range" 
            min="1" 
            max="5" 
            value={workload}
            onChange={(e) => setWorkload(parseInt(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[8px] font-black text-slate-300 uppercase tracking-widest">
             <span>Quick</span>
             <span>Massive</span>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <button 
          onClick={() => title && subject && onAdd(title, subject, priority, workload, dueDate)}
          className="flex-1 bg-slate-900 text-white py-5 rounded-[1.5rem] font-black uppercase text-xs tracking-[0.2em] hover:scale-105 shadow-xl shadow-slate-900/20 transition-all active:scale-95"
        >
          Confirm Deployment
        </button>
        <button 
          onClick={onCancel}
          className="px-8 py-5 bg-slate-50 text-slate-400 rounded-[1.5rem] font-black uppercase text-xs tracking-[0.2em] border border-slate-100 hover:bg-white hover:text-slate-600 transition-all"
        >
          Abort
        </button>
      </div>
    </motion.div>
  );
}
