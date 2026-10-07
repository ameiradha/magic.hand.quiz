import React, { useEffect, useRef, useState, useCallback } from "react";
import Webcam from "react-webcam";
import { motion, AnimatePresence } from "motion/react";
import { 
  Camera, CheckCircle2, XCircle, RefreshCcw, Trophy, 
  Hand, Timer, Volume2, Settings, Play, Plus, Trash2, 
  Image as ImageIcon, Save, ChevronLeft, ChevronRight,
  LogOut, LogIn, History as HistoryIcon, Library, BookOpen,
  User as UserIcon, Loader2, ExternalLink, FileUp, Sparkles
} from "lucide-react";
import { initHandDetection, countFingers } from "./lib/handDetection";
import { QUIZ_QUESTIONS as DEFAULT_QUESTIONS, Question } from "./constants";
import { auth, db, loginWithGoogle, logout, OperationType, handleFirestoreError } from "./firebase";
import { onAuthStateChanged, User } from "firebase/auth";
import { 
  collection, query, where, onSnapshot, orderBy, 
  addDoc, serverTimestamp, doc, setDoc, getDocs, deleteDoc, getDoc 
} from "firebase/firestore";
import * as XLSX from 'xlsx';
import { GoogleGenAI, Type } from "@google/genai";

export interface QuizTopic {
  id: string;
  title: string;
  description?: string;
  authorId: string;
  createdAt: any;
  questions: Question[];
}

export interface HistoryRecord {
  id: string;
  userId: string;
  quizId: string;
  quizTitle: string;
  score: number;
  totalQuestions: number;
  completedAt: any;
}

const CONFIRMATION_TIME = 1500; // 1.5 seconds to confirm selection

// Sound URLs
const CORRECT_SOUND = "https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3";
const WRONG_SOUND = "https://assets.mixkit.co/active_storage/sfx/2959/2959-preview.mp3";

export default function App() {
  const webcamRef = useRef<Webcam>(null);
  const [detector, setDetector] = useState<any>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  const [mode, setMode] = useState<'quiz' | 'editor' | 'library' | 'history'>('library');
  const [quizzes, setQuizzes] = useState<QuizTopic[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [selectedQuiz, setSelectedQuiz] = useState<QuizTopic | null>(null);
  
  const [questions, setQuestions] = useState<Question[]>(DEFAULT_QUESTIONS);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [isQuizFinished, setIsQuizFinished] = useState(false);
  const [detectedFingers, setDetectedFingers] = useState(0);
  const [selectionProgress, setSelectionProgress] = useState(0);
  const [lastDetectedFingers, setLastDetectedFingers] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<"correct" | "incorrect" | null>(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [isIframe, setIsIframe] = useState(false);

  useEffect(() => {
    setIsIframe(window.self !== window.top);
  }, []);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [webcamKey, setWebcamKey] = useState(0);
  const [permissionStatus, setPermissionStatus] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');

  // Use refs for values that change frequently to keep the detection loop stable
  const startTimeRef = useRef<number | null>(null);
  const lastDetectedFingersRef = useRef<number>(0);
  const feedbackRef = useRef<string | null>(null);
  const isQuizFinishedRef = useRef<boolean>(false);
  const currentQuestionRef = useRef<Question | null>(null);

  const currentQuestion = questions[currentQuestionIndex];

  // Sync refs with state
  useEffect(() => { feedbackRef.current = feedback; }, [feedback]);
  useEffect(() => { isQuizFinishedRef.current = isQuizFinished; }, [isQuizFinished]);
  useEffect(() => { currentQuestionRef.current = currentQuestion; }, [currentQuestion]);

  // Editor State
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Persist questions with debounce
  useEffect(() => {
    const timeout = setTimeout(() => {
      localStorage.setItem('gesture_quiz_questions', JSON.stringify(questions));
    }, 1000);
    return () => clearTimeout(timeout);
  }, [questions]);

  const [showCameraTest, setShowCameraTest] = useState(false);
  const [pendingQuiz, setPendingQuiz] = useState<QuizTopic | null>(null);

  // AI Generator State
  const [showAiGenerator, setShowAiGenerator] = useState(false);
  const [aiTopic, setAiTopic] = useState("");
  const [aiQuestionCount, setAiQuestionCount] = useState(30);
  const [isGenerating, setIsGenerating] = useState(false);

  // Initialize detector
  useEffect(() => {
    initHandDetection().then(setDetector);
    
    if (!window.isSecureContext) {
      setCameraError("Camera access requires a secure (HTTPS) connection. Please ensure you are using HTTPS.");
    } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("Browser does not support mediaDevices.getUserMedia");
      setCameraError("Your browser does not support camera access or it is blocked by security settings.");
    }

    // Check permission status if API is available
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'camera' as PermissionName }).then((status) => {
        console.log("Initial camera permission status:", status.state);
        setPermissionStatus(status.state as any);
        status.onchange = () => {
          console.log("Camera permission status changed to:", status.state);
          setPermissionStatus(status.state as any);
          if (status.state === 'granted') {
            setCameraError(null);
            setWebcamKey(prev => prev + 1);
          }
        };
      }).catch(err => console.warn("Permissions API not supported for camera:", err));
    }
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setIsAuthReady(true);
      if (u) {
        // Sync user to Firestore
        const userRef = doc(db, 'users', u.uid);
        try {
          const userDoc = await getDoc(userRef);
          if (!userDoc.exists()) {
            await setDoc(userRef, {
              uid: u.uid,
              email: u.email,
              displayName: u.displayName,
              photoURL: u.photoURL,
              createdAt: serverTimestamp()
            });
          } else {
            await setDoc(userRef, {
              displayName: u.displayName,
              photoURL: u.photoURL
            }, { merge: true });
          }
        } catch (error) {
          console.error("User sync failed:", error);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch Quizzes
  useEffect(() => {
    if (!isAuthReady) return;
    const q = query(collection(db, 'quizzes'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const quizList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as QuizTopic));
      setQuizzes(quizList);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'quizzes'));
    return () => unsubscribe();
  }, [isAuthReady]);

  // Fetch History
  useEffect(() => {
    if (!user) {
      setHistory([]);
      return;
    }
    const q = query(
      collection(db, 'history'), 
      where('userId', '==', user.uid),
      orderBy('completedAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const historyList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as HistoryRecord));
      setHistory(historyList);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'history'));
    return () => unsubscribe();
  }, [user]);

  const startQuiz = (quiz: QuizTopic) => {
    if (!isCameraReady) {
      setPendingQuiz(quiz);
      setShowCameraTest(true);
      return;
    }
    setSelectedQuiz(quiz);
    setQuestions(quiz.questions);
    setCurrentQuestionIndex(0);
    setScore(0);
    setIsQuizFinished(false);
    setMode('quiz');
  };

  const saveQuizAttempt = async (finalScore: number) => {
    if (!user || !selectedQuiz) return;
    try {
      await addDoc(collection(db, 'history'), {
        userId: user.uid,
        quizId: selectedQuiz.id,
        quizTitle: selectedQuiz.title,
        score: finalScore,
        totalQuestions: questions.length,
        completedAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'history');
    }
  };

  const createNewQuiz = async () => {
    if (!user) return;
    const newQuiz: Omit<QuizTopic, 'id'> = {
      title: "New Quiz Topic",
      description: "Enter a description...",
      authorId: user.uid,
      createdAt: serverTimestamp(),
      questions: [DEFAULT_QUESTIONS[0]]
    };
    try {
      const sanitizedQuiz = sanitizeForFirestore(newQuiz);
      const docRef = await addDoc(collection(db, 'quizzes'), sanitizedQuiz);
      const quizWithId = { ...newQuiz, id: docRef.id } as QuizTopic;
      setEditingQuestion(null);
      setSelectedQuiz(quizWithId);
      setQuestions(quizWithId.questions);
      setMode('editor');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'quizzes');
    }
  };

  const sanitizeForFirestore = (obj: any): any => {
    if (Array.isArray(obj)) {
      return obj.map(sanitizeForFirestore);
    } else if (obj !== null && typeof obj === 'object' && obj.constructor === Object) {
      const sanitized: any = {};
      for (const key in obj) {
        if (obj[key] !== undefined) {
          sanitized[key] = sanitizeForFirestore(obj[key]);
        }
      }
      return sanitized;
    }
    return obj;
  };

  const updateQuizInFirestore = async (updatedQuestions: Question[]) => {
    if (!user || !selectedQuiz) return;
    try {
      const sanitizedQuestions = sanitizeForFirestore(updatedQuestions);
      const quizRef = doc(db, 'quizzes', selectedQuiz.id);
      await setDoc(quizRef, { questions: sanitizedQuestions }, { merge: true });
      setSelectedQuiz({ ...selectedQuiz, questions: sanitizedQuestions });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `quizzes/${selectedQuiz.id}`);
    }
  };

  const playSound = (type: "correct" | "incorrect") => {
    if (!soundEnabled) return;
    const audio = new Audio(type === "correct" ? CORRECT_SOUND : WRONG_SOUND);
    audio.play().catch(e => console.error("Audio play failed", e));
  };

  const handleNextQuestion = useCallback(() => {
    setFeedback(null);
    setSelectionProgress(0);
    setStartTime(null);
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex((prev) => prev + 1);
    } else {
      setIsQuizFinished(true);
      saveQuizAttempt(score);
    }
  }, [currentQuestionIndex, questions.length, score, user, selectedQuiz]);

  const requestCameraPermission = async () => {
    try {
      setCameraError(null);
      
      if (!window.isSecureContext) {
        setCameraError("Camera access requires a secure (HTTPS) connection. Please ensure you are using HTTPS.");
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError("Your browser does not support camera access or it is blocked by security settings.");
        return;
      }

      // Check permission status if API is available
      if (navigator.permissions && navigator.permissions.query) {
        try {
          const status = await navigator.permissions.query({ name: 'camera' as any });
          setPermissionStatus(status.state);
          if (status.state === 'denied') {
            setCameraError("Camera permission is explicitly DENIED in your browser settings. You MUST click the lock icon 🔒 in the address bar and reset the permission.");
            return;
          }
        } catch (e) {
          console.warn("Permissions API query failed:", e);
        }
      }

      // Try to get a stream to trigger the prompt
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: "user"
          },
          audio: false
        });
      } catch (e) {
        // Fallback to basic video if constraints fail
        console.warn("Ideal constraints failed, trying basic video:", e);
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      
      // If successful, stop the tracks and update state
      stream.getTracks().forEach(track => track.stop());
      setIsCameraReady(true);
      setWebcamKey(prev => prev + 1);
      
      // Update permission status manually if API is not available
      if (!navigator.permissions) {
        setPermissionStatus('granted');
      }
    } catch (err: any) {
      console.error("Manual Permission Check Error:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setCameraError("Camera access was denied by the browser. This usually happens when the app is inside an iframe.");
        setPermissionStatus('denied');
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        setCameraError("No camera device was found. Please connect a camera and try again.");
      } else {
        setCameraError(`Camera error: ${err.message || "Unknown error"}.`);
      }
    }
  };

  // Keyboard Support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'quiz' || isQuizFinished || feedback) return;
      
      const key = parseInt(e.key);
      if (key >= 1 && key <= 4) {
        setDetectedFingers(key);
        // Simulate selection progress for keyboard users
        setSelectionProgress(100);
        
        const currentQ = questions[currentQuestionIndex];
        if (currentQ) {
          const isCorrect = (key - 1) === currentQ.correctAnswer;
          setFeedback(isCorrect ? "correct" : "incorrect");
          if (isCorrect) setScore(prev => prev + 1);
          playSound(isCorrect ? "correct" : "incorrect");
          setTimeout(handleNextQuestion, 2000);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, isQuizFinished, feedback, questions, currentQuestionIndex, handleNextQuestion]);

  // Auto-start quiz if camera becomes ready while test modal is open
  useEffect(() => {
    if (showCameraTest && isCameraReady && pendingQuiz) {
      setSelectedQuiz(pendingQuiz);
      setQuestions(pendingQuiz.questions);
      setCurrentQuestionIndex(0);
      setScore(0);
      setIsQuizFinished(false);
      setMode('quiz');
      setPendingQuiz(null);
      setShowCameraTest(false);
    }
  }, [showCameraTest, isCameraReady, pendingQuiz]);

  const detect = useCallback(async () => {
    if (
      mode === 'quiz' &&
      detector &&
      webcamRef.current &&
      webcamRef.current.video &&
      webcamRef.current.video.readyState === 4 &&
      !feedbackRef.current &&
      !isQuizFinishedRef.current &&
      currentQuestionRef.current
    ) {
      const video = webcamRef.current.video;
      const results = detector.detectForVideo(video, performance.now());

      if (results.landmarks && results.landmarks.length > 0) {
        const fingers = countFingers(results.landmarks[0]);
        setDetectedFingers(fingers);

        if (fingers >= 1 && fingers <= 4) {
          if (fingers === lastDetectedFingersRef.current) {
            if (startTimeRef.current) {
              const elapsed = performance.now() - startTimeRef.current;
              const progress = Math.min((elapsed / CONFIRMATION_TIME) * 100, 100);
              setSelectionProgress(progress);

              if (progress >= 100) {
                // Confirm selection
                const selectedIndex = fingers - 1;
                const q = currentQuestionRef.current;
                if (q && selectedIndex === q.correctAnswer) {
                  setScore((prev) => prev + 1);
                  setFeedback("correct");
                  playSound("correct");
                } else {
                  setFeedback("incorrect");
                  playSound("incorrect");
                }
                // Reset refs for next question
                startTimeRef.current = null;
                lastDetectedFingersRef.current = 0;
                // Auto-advance after 2 seconds
                setTimeout(handleNextQuestion, 2000);
              }
            } else {
              startTimeRef.current = performance.now();
            }
          } else {
            lastDetectedFingersRef.current = fingers;
            startTimeRef.current = performance.now();
            setSelectionProgress(0);
          }
        } else {
          startTimeRef.current = null;
          setSelectionProgress(0);
          lastDetectedFingersRef.current = 0;
          setDetectedFingers(0);
        }
      } else {
        setDetectedFingers(0);
        startTimeRef.current = null;
        setSelectionProgress(0);
        lastDetectedFingersRef.current = 0;
      }
    }
  }, [detector, handleNextQuestion, mode]);

  useEffect(() => {
    let animationId: number;
    const loop = () => {
      detect();
      animationId = requestAnimationFrame(loop);
    };

    if (detector && mode === 'quiz') {
      animationId = requestAnimationFrame(loop);
    }
    return () => cancelAnimationFrame(animationId);
  }, [detector, detect, mode]);

  const resetQuiz = () => {
    setCurrentQuestionIndex(0);
    setScore(0);
    setIsQuizFinished(false);
    setFeedback(null);
    setSelectionProgress(0);
  };

  // Editor Functions
  const addQuestion = useCallback(() => {
    const newId = Date.now();
    const newQuestion: Question = {
      id: newId,
      text: "New Question",
      options: ["Option A", "Option B", "Option C", "Option D"],
      correctAnswer: 0
    };
    setQuestions(prev => {
      const next = [...prev, newQuestion];
      updateQuizInFirestore(next);
      return next;
    });
    setEditingQuestion(newQuestion);
  }, [questions, selectedQuiz, user]);

  const updateQuestion = useCallback((updated: Question) => {
    setQuestions(prev => {
      const next = prev.map(q => q.id === updated.id ? updated : q);
      updateQuizInFirestore(next);
      return next;
    });
    setEditingQuestion(updated);
  }, [selectedQuiz, user]);

  const deleteQuestion = useCallback((id: number) => {
    setQuestions(prev => {
      const next = prev.filter(q => q.id !== id);
      updateQuizInFirestore(next);
      return next;
    });
    setEditingQuestion(prev => prev?.id === id ? null : prev);
  }, [selectedQuiz, user]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, optionIndex?: number) => {
    const file = e.target.files?.[0];
    if (file && editingQuestion) {
      if (file.size > 1024 * 1024) { // 1MB limit for localStorage safety
        setNotification({ message: "Image is too large. Please select an image under 1MB.", type: 'error' });
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        if (optionIndex !== undefined) {
          const newOpts = [...editingQuestion.options];
          const currentOpt = newOpts[optionIndex];
          const optObj = typeof currentOpt === 'string' ? { text: currentOpt } : currentOpt;
          newOpts[optionIndex] = { ...optObj, imageUrl: result };
          updateQuestion({ ...editingQuestion, options: newOpts });
        } else {
          updateQuestion({ ...editingQuestion, imageUrl: result });
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const generateAiQuestions = async () => {
    if (!aiTopic.trim() || isGenerating || !selectedQuiz) return;
    setIsGenerating(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Generate exactly ${aiQuestionCount} multiple-choice questions about "${aiTopic}". 
        IMPORTANT: Your response must be a JSON array with exactly ${aiQuestionCount} items.
        Each question must have exactly 4 options.
        The questions and answers should be fun and suitable for kids.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                text: { type: Type.STRING, description: "The question text." },
                options: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING },
                  description: "Exactly 4 answer options as strings." 
                },
                correctAnswer: { 
                  type: Type.INTEGER, 
                  description: "Index of the correct answer (0-3)." 
                }
              },
              required: ["text", "options", "correctAnswer"]
            }
          }
        }
      });

      const text = response.text;
      if (!text) throw new Error("No response from AI");
      
      const generatedData = JSON.parse(text.trim());
      const newQuestions: Question[] = generatedData.map((q: any, index: number) => ({
        id: Date.now() + index,
        text: q.text,
        options: q.options,
        correctAnswer: q.correctAnswer,
        imageUrl: null
      }));

      const updatedQuestions = [...questions, ...newQuestions];
      
      // Update Quiz Title if it's the default one
      let updatedQuiz = { ...selectedQuiz, questions: updatedQuestions };
      if (selectedQuiz.title === "New Quiz Topic" || selectedQuiz.title === "") {
        updatedQuiz.title = aiTopic;
      }

      const quizRef = doc(db, 'quizzes', selectedQuiz.id);
      await setDoc(quizRef, { 
        questions: sanitizeForFirestore(updatedQuestions),
        title: updatedQuiz.title 
      }, { merge: true });

      setQuestions(updatedQuestions);
      setSelectedQuiz(updatedQuiz);
      setNotification({ message: `Successfully generated ${newQuestions.length} questions!`, type: 'success' });
      setShowAiGenerator(false);
      setAiTopic("");
    } catch (error) {
      console.error("AI Generation failed:", error);
      setNotification({ message: "AI Generation failed. Please try again.", type: 'error' });
    } finally {
      setIsGenerating(false);
    }
  };

  const deleteQuiz = async (quizId: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'quizzes', quizId));
      setDeleteConfirmId(null);
      setNotification({ message: "Game deleted successfully!", type: 'success' });
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `quizzes/${quizId}`);
      setNotification({ message: "Oops! Couldn't delete the game.", type: 'error' });
    }
  };

  const handleXlsxUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !selectedQuiz) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = evt.target?.result;
        const wb = XLSX.read(data, { type: 'array' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const jsonData = XLSX.utils.sheet_to_json(ws) as any[];

        if (jsonData.length === 0) {
          setNotification({ message: "The file is empty!", type: 'error' });
          return;
        }

        const importedQuestions: Question[] = jsonData.map((row, index) => ({
          id: Date.now() + index,
          text: row.Question || row.question || `Question ${index + 1}`,
          options: [
            row['Option 1'] || row.option1 || "A",
            row['Option 2'] || row.option2 || "B",
            row['Option 3'] || row.option3 || "C",
            row['Option 4'] || row.option4 || "D",
          ],
          correctAnswer: (parseInt(row['Correct Answer'] || row.correctAnswer) - 1) || 0,
          imageUrl: row['Image URL'] || row.imageUrl || null
        }));

        const updatedQuestions = [...questions, ...importedQuestions];
        await updateQuizInFirestore(updatedQuestions);
        setQuestions(updatedQuestions);
        setNotification({ message: `Successfully imported ${importedQuestions.length} questions!`, type: 'success' });
      } catch (error) {
        console.error("Error parsing XLSX:", error);
        setNotification({ message: "Error parsing the file. Please check the format.", type: 'error' });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  if (!detector) {
    return (
      <div className="min-h-screen bg-kids-bg flex flex-col items-center justify-center text-kids-text font-display">
        <motion.div
          animate={{ rotate: 360, scale: [1, 1.2, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          className="mb-6"
        >
          <Hand size={80} className="text-kids-primary drop-shadow-lg" />
        </motion.div>
        <p className="text-2xl font-bold animate-bounce">Waking up the Magic Hand...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-kids-bg text-kids-text font-sans selection:bg-kids-primary/30">
      {/* Header */}
      <header className="border-b-4 border-kids-text/5 p-6 flex justify-between items-center bg-white sticky top-0 z-50 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-kids-primary rounded-2xl flex items-center justify-center shadow-lg rotate-[-5deg]">
            <Hand size={28} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-black tracking-tight text-kids-primary">MAGIC GESTURE!</h1>
            <p className="text-xs font-bold text-kids-secondary uppercase tracking-widest">Play with your hands! ✨</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <nav className="flex bg-kids-text/5 p-1 rounded-2xl mr-4">
            <button
              onClick={() => setMode('library')}
              className={`px-6 py-2 rounded-xl flex items-center gap-2 text-sm font-bold transition-all ${mode === 'library' ? 'bg-kids-secondary text-white shadow-md' : 'text-kids-text/60 hover:text-kids-text'}`}
            >
              <Library size={18} /> Play
            </button>
            {user && (
              <button
                onClick={() => setMode('history')}
                className={`px-6 py-2 rounded-xl flex items-center gap-2 text-sm font-bold transition-all ${mode === 'history' ? 'bg-kids-secondary text-white shadow-md' : 'text-kids-text/60 hover:text-kids-text'}`}
              >
                <HistoryIcon size={18} /> Stars
              </button>
            )}
            <button
              onClick={() => setMode('editor')}
              className={`px-6 py-2 rounded-xl flex items-center gap-2 text-sm font-bold transition-all ${mode === 'editor' ? 'bg-kids-secondary text-white shadow-md' : 'text-kids-text/60 hover:text-kids-text'}`}
            >
              <Settings size={18} /> Create
            </button>
          </nav>

          <div className="h-8 w-1 bg-kids-text/10 mx-2 rounded-full" />

          {user ? (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-full border-2 border-kids-text/5 shadow-sm">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full border-2 border-kids-secondary" />
                ) : (
                  <div className="w-8 h-8 bg-kids-secondary/20 rounded-full flex items-center justify-center text-kids-secondary">
                    <UserIcon size={16} />
                  </div>
                )}
                <span className="text-sm font-bold hidden md:block">{user.displayName}</span>
              </div>
              <button
                onClick={logout}
                className="p-2 hover:bg-kids-primary/10 hover:text-kids-primary rounded-xl transition-all"
                title="Logout"
              >
                <LogOut size={20} />
              </button>
            </div>
          ) : (
            <button
              onClick={loginWithGoogle}
              className="kids-btn kids-btn-primary flex items-center gap-2"
            >
              <LogIn size={18} /> Join the Fun!
            </button>
          )}
          
          <div className="h-8 w-1 bg-kids-text/10 mx-2 rounded-full" />

          <button 
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-3 rounded-xl border-2 transition-all ${soundEnabled ? "bg-kids-accent/20 border-kids-accent text-kids-text" : "bg-white border-kids-text/10 text-kids-text/30"}`}
          >
            <Volume2 size={20} />
          </button>

          <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-xl border-2 border-kids-text/5 shadow-sm">
            <div className={`w-3 h-3 rounded-full ${isCameraReady ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-[10px] font-black text-kids-text/40 uppercase tracking-widest hidden sm:block">
              {isCameraReady ? 'Camera ON' : 'Camera OFF'}
            </span>
          </div>

          {mode === 'quiz' && !isQuizFinished && (
            <div className="flex items-center gap-6 font-mono border-l border-white/10 pl-6">
              <div className="text-right">
                <p className="text-[10px] text-kids-text/40 uppercase">Progress</p>
                <p className="text-lg font-bold text-kids-text">{currentQuestionIndex + 1} / {questions.length}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-kids-text/40 uppercase">Score</p>
                <p className="text-lg font-bold text-kids-primary">{score}</p>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-8">
        <AnimatePresence mode="wait">
          {!isAuthReady ? (
            <div className="flex flex-col items-center justify-center py-20">
              <Loader2 className="animate-spin text-kids-primary mb-4" size={48} />
              <p className="text-kids-text/40 font-bold">Waking up the Magic Hand...</p>
            </div>
          ) : mode === 'library' ? (
            <motion.div
              key="library-mode"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-4xl font-display font-black text-kids-primary">Choose an Adventure!</h2>
                    <p className="text-lg font-bold text-kids-text/50">Pick a topic and show your magic hands! ✨</p>
                  </div>
                  {user && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={createNewQuiz}
                        className="kids-btn kids-btn-primary flex items-center gap-2"
                      >
                        <Plus size={24} /> Create a Game
                      </button>
                    </div>
                  )}
                </div>

              {!isCameraReady && (
                <div className="bg-kids-accent/20 border-4 border-kids-accent rounded-[2.5rem] p-8 flex flex-col md:flex-row items-center justify-between gap-8 shadow-sm">
                  <div className="flex items-center gap-6">
                    <div className="w-16 h-16 bg-white rounded-3xl flex items-center justify-center text-kids-primary shadow-md rotate-3">
                      <Camera size={32} />
                    </div>
                    <div>
                      <h3 className="text-2xl font-display font-black">Camera Magic Needed!</h3>
                      <p className="text-lg font-bold text-kids-text/60">We need to see your hands to play the game!</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 w-full md:w-auto">
                    <button
                      onClick={requestCameraPermission}
                      className="kids-btn kids-btn-primary flex-1 md:flex-none"
                    >
                      Turn on Camera
                    </button>
                    <button
                      onClick={() => setShowCameraTest(true)}
                      className="kids-btn bg-white border-4 border-kids-text/5 text-kids-text flex-1 md:flex-none"
                    >
                      Test It
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {quizzes.length === 0 ? (
                  <div className="col-span-full py-20 text-center bg-white rounded-[3rem] border-4 border-kids-text/5 border-dashed">
                    <BookOpen className="mx-auto text-kids-text/10 mb-4" size={64} />
                    <h3 className="text-2xl font-display font-black text-kids-text/40 mb-2">No Games Yet!</h3>
                    <p className="text-kids-text/30 font-bold mb-8">Be the first to create a magic adventure!</p>
                    {!user && (
                      <button onClick={loginWithGoogle} className="kids-btn kids-btn-primary">Login to Create</button>
                    )}
                  </div>
                ) : (
                  quizzes.map((quiz, idx) => {
                    const colors = [
                      'border-kids-primary/20 bg-kids-primary/5',
                      'border-kids-secondary/20 bg-kids-secondary/5',
                      'border-kids-accent/20 bg-kids-accent/5',
                    ];
                    const colorClass = colors[idx % colors.length];
                    
                    return (
                      <motion.div
                        key={quiz.id}
                        whileHover={{ scale: 1.02, y: -8 }}
                        className={`kids-card flex flex-col gap-6 group ${colorClass} hover:border-kids-primary/40 transition-all duration-300`}
                      >
                        <div className="flex items-center justify-between">
                          <div className={`w-14 h-14 rounded-[1.5rem] flex items-center justify-center shadow-inner ${
                            idx % 3 === 0 ? 'bg-kids-primary/20 text-kids-primary' :
                            idx % 3 === 1 ? 'bg-kids-secondary/20 text-kids-secondary' :
                            'bg-kids-accent/20 text-kids-text'
                          }`}>
                            <BookOpen size={28} />
                          </div>
                          <div className={`px-4 py-1.5 rounded-full border-2 ${
                            idx % 3 === 0 ? 'bg-kids-primary/10 border-kids-primary/20 text-kids-primary' :
                            idx % 3 === 1 ? 'bg-kids-secondary/10 border-kids-secondary/20 text-kids-secondary' :
                            'bg-kids-accent/10 border-kids-accent/20 text-kids-text/60'
                          }`}>
                            <span className="text-xs font-black uppercase tracking-widest">{quiz.questions.length} Cards</span>
                          </div>
                        </div>
                        <div>
                          <h3 className="text-2xl font-display font-black text-kids-text mb-2 group-hover:text-kids-primary transition-colors">{quiz.title}</h3>
                          <p className="text-base font-bold text-kids-text/50 line-clamp-2 leading-relaxed">{quiz.description}</p>
                        </div>
                        <div className="mt-auto pt-4 flex items-center gap-3">
                          <button
                            onClick={() => startQuiz(quiz)}
                            className={`kids-btn flex-1 py-4 text-base ${
                              idx % 3 === 0 ? 'kids-btn-primary' :
                              idx % 3 === 1 ? 'kids-btn-secondary' :
                              'kids-btn-accent'
                            }`}
                          >
                            Play Now!
                          </button>
                          {user?.uid === quiz.authorId && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => { setSelectedQuiz(quiz); setQuestions(quiz.questions); setMode('editor'); }}
                                className="p-4 bg-white/50 hover:bg-white rounded-2xl transition-all border-2 border-kids-text/5 hover:border-kids-primary/20"
                                title="Edit Game"
                              >
                                <Settings size={22} className="text-kids-text/30" />
                              </button>
                              <button
                                onClick={() => setDeleteConfirmId(quiz.id)}
                                className="p-4 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-2xl transition-all border-2 border-red-500/10"
                                title="Delete Game"
                              >
                                <Trash2 size={22} />
                              </button>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </div>

              <div className="pt-16 border-t-4 border-kids-text/5">
                <div className="max-w-4xl mx-auto">
                  <h3 className="text-2xl font-display font-black mb-8 flex items-center gap-4 text-kids-text">
                    <div className="p-3 bg-kids-accent rounded-2xl shadow-sm">
                      <Settings className="text-kids-text" size={24} />
                    </div>
                    Camera Magic Help! ✨
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="kids-card border-kids-primary/10 bg-white/50">
                      <p className="text-lg font-black text-kids-primary mb-2">1. The Lock Icon 🔒</p>
                      <p className="text-base font-bold text-kids-text/60 leading-relaxed">
                        Click the <b>Lock</b> icon up top in your browser. Make sure <b>Camera</b> is turned <b>ON</b>!
                      </p>
                    </div>
                    <div className="kids-card border-kids-secondary/10 bg-white/50">
                      <p className="text-lg font-black text-kids-secondary mb-2">2. New Tab Trick 🚀</p>
                      <p className="text-base font-bold text-kids-text/60 leading-relaxed">
                        If the camera is shy, click the <b>Open in New Tab</b> button. It fixes almost everything!
                      </p>
                    </div>
                    <div className="kids-card border-kids-accent/10 bg-white/50">
                      <p className="text-lg font-black text-kids-text/60 mb-2">3. Other Apps 📱</p>
                      <p className="text-base font-bold text-kids-text/60 leading-relaxed">
                        Make sure other apps like Zoom or Teams aren't using your camera right now!
                      </p>
                    </div>
                    <div className="kids-card border-kids-primary/10 bg-white/50">
                      <p className="text-lg font-black text-kids-primary mb-2">4. Keyboard Power! ⌨️</p>
                      <p className="text-base font-bold text-kids-text/60 leading-relaxed">
                        No camera? No problem! Use the <b>1, 2, 3, and 4</b> keys on your keyboard to play!
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          ) : mode === 'history' ? (
            <motion.div
              key="history-mode"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="flex items-center gap-6">
                <button onClick={() => setMode('library')} className="p-4 bg-white rounded-2xl shadow-sm hover:bg-kids-secondary/10 transition-all border-2 border-kids-text/5">
                  <ChevronLeft size={32} className="text-kids-primary" />
                </button>
                <h2 className="text-4xl font-display font-black text-kids-primary">Your Super Stars! ⭐</h2>
              </div>

              <div className="kids-card overflow-hidden !p-0">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-kids-secondary/10 border-b-4 border-kids-text/5">
                      <th className="p-6 text-sm font-black uppercase tracking-widest text-kids-text/40">Game</th>
                      <th className="p-6 text-sm font-black uppercase tracking-widest text-kids-text/40">Points</th>
                      <th className="p-6 text-sm font-black uppercase tracking-widest text-kids-text/40">Magic Meter</th>
                      <th className="p-6 text-sm font-black uppercase tracking-widest text-kids-text/40">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-20 text-center text-kids-text/20 italic font-bold text-xl">No stars yet! Play a game to earn some! 🚀</td>
                      </tr>
                    ) : (
                      history.map((record) => (
                        <tr key={record.id} className="border-b-2 border-kids-text/5 hover:bg-kids-secondary/5 transition-colors">
                          <td className="p-6 font-black text-lg">{record.quizTitle}</td>
                          <td className="p-6">
                            <span className="text-kids-primary font-black text-2xl">{record.score}</span>
                            <span className="text-kids-text/20 font-bold"> / {record.totalQuestions}</span>
                          </td>
                          <td className="p-6">
                            <div className="flex items-center gap-4">
                              <div className="w-32 h-4 bg-kids-text/5 rounded-full overflow-hidden border-2 border-white shadow-inner">
                                <div 
                                  className="h-full bg-kids-secondary shadow-[0_0_10px_rgba(78,205,196,0.5)]" 
                                  style={{ width: `${(record.score / record.totalQuestions) * 100}%` }} 
                                />
                              </div>
                              <span className="text-sm font-black text-kids-secondary">{Math.round((record.score / record.totalQuestions) * 100)}%</span>
                            </div>
                          </td>
                          <td className="p-6 text-sm font-bold text-kids-text/40">
                            {record.completedAt?.toDate?.() ? record.completedAt.toDate().toLocaleDateString() : 'Just now!'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </motion.div>
          ) : mode === 'quiz' ? (
            <motion.div
              key="quiz-mode"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start"
            >
              {isQuizFinished ? (
                <div className="col-span-full flex flex-col items-center justify-center py-20 text-center">
                  <motion.div
                    initial={{ scale: 0.5, rotate: -20 }}
                    animate={{ scale: 1, rotate: 0 }}
                    className="w-40 h-40 bg-kids-accent rounded-[3rem] flex items-center justify-center mx-auto mb-8 shadow-xl border-8 border-white"
                  >
                    <Trophy size={80} className="text-kids-text" />
                  </motion.div>
                  <h2 className="text-5xl font-display font-black mb-4 text-kids-primary">YOU DID IT! 🌟</h2>
                  <p className="text-2xl font-bold text-kids-text/60 mb-12">
                    You got <span className="text-kids-secondary text-4xl">{score}</span> points!
                  </p>
                  
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
                    <button
                      onClick={resetQuiz}
                      className="kids-btn kids-btn-primary w-full sm:w-auto flex items-center justify-center gap-3 text-xl py-5 px-10"
                    >
                      <RefreshCcw size={24} />
                      Play Again!
                    </button>
                    <button
                      onClick={() => setMode('library')}
                      className="kids-btn kids-btn-secondary w-full sm:w-auto flex items-center justify-center gap-3 text-xl py-5 px-10"
                    >
                      <Library size={24} />
                      More Games
                    </button>
                  </div>
                </div>
              ) : currentQuestion ? (
                <>
                  {/* Camera Section */}
                  <div className="space-y-8">
                    <div className="relative aspect-video rounded-[3rem] overflow-hidden border-8 border-white bg-kids-text shadow-2xl group">
                      <Webcam
                        key={webcamKey}
                        ref={webcamRef}
                        mirrored={true}
                        audio={false}
                        playsInline={true}
                        screenshotFormat="image/jpeg"
                        videoConstraints={{
                          facingMode: "user",
                        }}
                        onUserMedia={() => {
                          setIsCameraReady(true);
                          setCameraError(null);
                        }}
                        onUserMediaError={(err: any) => {
                          console.error("Webcam Error:", err);
                          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
                            setCameraError("Oops! We can't see your magic hands. Please click the lock icon 🔒 and turn on the camera!");
                          } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
                            setCameraError("We can't find a camera! Is it plugged in?");
                          } else {
                            setCameraError(`Camera error: ${err.message || "Unknown error"}. Try reloading!`);
                          }
                        }}
                        disablePictureInPicture={true}
                        forceScreenshotSourceSize={false}
                        imageSmoothing={true}
                        screenshotQuality={0.92}
                        className="w-full h-full object-cover opacity-90"
                      />
                      
                      {/* Overlay UI */}
                      <div className="absolute inset-0 pointer-events-none">
                        <div className="absolute inset-0 bg-kids-primary/5" />
                        <div className="absolute top-8 left-8 w-12 h-12 border-t-4 border-l-4 border-kids-accent rounded-tl-3xl" />
                        <div className="absolute top-8 right-8 w-12 h-12 border-t-4 border-r-4 border-kids-accent rounded-tr-3xl" />
                        <div className="absolute bottom-8 left-8 w-12 h-12 border-b-4 border-l-4 border-kids-accent rounded-bl-3xl" />
                        <div className="absolute bottom-8 right-8 w-12 h-12 border-b-4 border-r-4 border-kids-accent rounded-br-3xl" />

                        <div className="absolute top-8 left-1/2 -translate-x-1/2 flex items-center gap-3 px-6 py-3 bg-white rounded-full border-4 border-kids-accent shadow-lg">
                          <div className={`w-4 h-4 rounded-full ${detectedFingers > 0 ? "bg-green-500 animate-ping" : "bg-red-500"}`} />
                          <span className="text-sm font-black uppercase tracking-widest text-kids-text">
                            {detectedFingers > 0 ? `I SEE ${detectedFingers} FINGERS!` : "SHOW ME YOUR HAND!"}
                          </span>
                        </div>

                        {selectionProgress > 0 && !feedback && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="relative w-24 h-24">
                              <svg className="w-full h-full -rotate-90">
                                <circle cx="48" cy="48" r="40" fill="none" stroke="currentColor" strokeWidth="8" className="text-white/10" />
                                <circle
                                  cx="48" cy="48" r="40" fill="none" stroke="currentColor" strokeWidth="8"
                                  strokeDasharray={251.2}
                                  strokeDashoffset={251.2 - (251.2 * selectionProgress) / 100}
                                  className="text-blue-500 transition-all duration-100"
                                />
                              </svg>
                              <div className="absolute inset-0 flex items-center justify-center font-mono font-bold">{detectedFingers}</div>
                            </div>
                          </div>
                        )}

                        <AnimatePresence>
                          {cameraError && (
                            <motion.div
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="absolute inset-0 flex flex-col items-center justify-center bg-kids-primary/95 backdrop-blur-xl p-10 text-center z-[60]"
                            >
                              <div className="w-24 h-24 bg-white rounded-[2rem] flex items-center justify-center text-kids-primary shadow-xl mb-8 rotate-[-10deg]">
                                <Camera size={48} />
                              </div>
                              <h3 className="text-3xl font-display font-black text-white mb-4">Camera Magic Needed! ✨</h3>
                              
                              <div className="flex items-center gap-3 mb-8 px-6 py-2 bg-white/20 rounded-full border-2 border-white/30">
                                <div className={`w-3 h-3 rounded-full ${
                                  permissionStatus === 'granted' ? 'bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.5)]' : 
                                  permissionStatus === 'denied' ? 'bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.5)]' : 'bg-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.5)]'
                                }`} />
                                <span className="text-xs font-black uppercase tracking-widest text-white">
                                  Status: {permissionStatus}
                                </span>
                              </div>

                              <div className="text-lg font-bold text-white/90 max-w-md mb-10 leading-relaxed">
                                {cameraError}
                                <br /><br />
                                <div className="text-left bg-white/20 p-6 rounded-[2rem] border-2 border-white/30 space-y-4">
                                  <p className="text-sm font-black text-kids-accent uppercase tracking-widest">
                                    {isIframe ? "Iframe Block Detected" : "Quick Fix!"}
                                  </p>
                                  <p className="text-base font-bold text-white leading-relaxed">
                                    {isIframe 
                                      ? "Browsers block cameras inside preview windows. You MUST open the app in a new tab to use the camera magic!" 
                                      : "If it's still not working, click the button below to open in a new tab. It works like magic!"}
                                  </p>
                                </div>
                              </div>
                              <div className="flex flex-col gap-4 w-full max-w-sm">
                                <button 
                                  onClick={() => window.open(window.location.href, '_blank')}
                                  className="kids-btn bg-white text-kids-primary hover:bg-kids-accent hover:text-kids-text w-full py-5 text-lg flex items-center justify-center gap-3"
                                >
                                  <ExternalLink size={24} />
                                  Open in New Tab (Fix It!)
                                </button>
                                <button 
                                  onClick={requestCameraPermission}
                                  className="w-full px-6 py-4 bg-white/10 hover:bg-white/20 rounded-2xl text-base font-black text-white transition-all border-2 border-white/20"
                                >
                                  Try Again Here
                                </button>
                                <button 
                                  onClick={() => {
                                    navigator.clipboard.writeText(window.location.href);
                                    setNotification({ message: "App URL copied! Paste it into a new tab to fix camera magic!", type: 'success' });
                                  }}
                                  className="w-full px-6 py-4 bg-white/5 hover:bg-white/10 rounded-2xl text-base font-black text-white/60 transition-all border-2 border-transparent hover:border-white/10 flex items-center justify-center gap-3"
                                >
                                  <Save size={20} />
                                  Copy App URL
                                </button>
                                <button 
                                  onClick={() => setCameraError(null)}
                                  className="w-full px-6 py-4 bg-white/5 hover:bg-white/10 rounded-2xl text-base font-black text-white/60 transition-all border-2 border-transparent hover:border-white/10"
                                >
                                  Skip Camera (Use Keyboard 1-4)
                                </button>
                              </div>
                            </motion.div>
                          )}
                          {feedback && (
                            <motion.div
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 1.2 }}
                              className={`absolute inset-0 flex flex-col items-center justify-center backdrop-blur-sm ${feedback === "correct" ? "bg-green-500/20" : "bg-red-500/20"}`}
                            >
                              {feedback === "correct" ? (
                                <><CheckCircle2 size={80} className="text-green-500 mb-4" /><h3 className="text-3xl font-bold text-green-500">CORRECT</h3></>
                              ) : (
                                <><XCircle size={80} className="text-red-500 mb-4" /><h3 className="text-3xl font-bold text-red-500">INCORRECT</h3></>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    <div className="p-6 bg-kids-text/5 rounded-3xl border-4 border-kids-text/5 space-y-4">
                      <div className="flex items-center gap-3 text-kids-text/60">
                        <Timer size={18} />
                        <p className="text-sm font-bold">Hold your hand steady for 1.5s to confirm your answer.</p>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        {[1, 2, 3, 4].map((n) => (
                          <div key={n} className="flex flex-col items-center gap-1">
                            <div className={`w-full h-2 rounded-full ${detectedFingers === n ? "bg-kids-primary" : "bg-kids-text/10"}`} />
                            <span className="text-[8px] font-black text-kids-text/30 uppercase">{n} {n === 1 ? "Finger" : "Fingers"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Question Section */}
                  <motion.div
                    key={currentQuestion.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="space-y-8"
                  >
                    <div className="kids-card !p-10 border-kids-secondary/20">
                      <div className="flex items-center gap-4 mb-6">
                        <div className="px-4 py-1.5 bg-kids-secondary text-white rounded-full text-sm font-black shadow-sm">
                          CARD {currentQuestionIndex + 1}
                        </div>
                        <div className="h-2 flex-1 bg-kids-text/5 rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-kids-secondary"
                            initial={{ width: 0 }}
                            animate={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
                          />
                        </div>
                      </div>
                      
                      <h2 className="text-4xl font-display font-black text-kids-text leading-tight mb-8">
                        {currentQuestion.text}
                      </h2>

                      {currentQuestion.imageUrl && (
                        <div className="rounded-[2.5rem] overflow-hidden border-4 border-kids-text/5 mb-8 shadow-md">
                          <img 
                            src={currentQuestion.imageUrl} 
                            alt="Question" 
                            className="w-full h-64 object-cover"
                            referrerPolicy="no-referrer"
                          />
                        </div>
                      )}
                    </div>

                    <div className="grid gap-4">
                      {currentQuestion.options.map((option, index) => {
                        const isSelected = detectedFingers === index + 1;
                        const isCorrect = !!feedback && index === currentQuestion.correctAnswer;
                        const isWrong = feedback === "incorrect" && isSelected;
                        const optionText = typeof option === 'string' ? option : option.text;
                        const optionImage = typeof option === 'string' ? undefined : option.imageUrl;

                        return (
                          <motion.div
                            key={index}
                            animate={{ 
                              scale: isSelected ? 1.02 : 1,
                              x: isSelected ? 10 : 0
                            }}
                            className={`relative flex items-center gap-6 p-6 rounded-3xl border-4 transition-all ${
                              isCorrect ? "bg-green-500/20 border-green-500 shadow-lg" :
                              isWrong ? "bg-red-500/20 border-red-500 shadow-lg" :
                              isSelected ? "bg-kids-accent/20 border-kids-accent shadow-lg" :
                              "bg-white border-kids-text/5 hover:border-kids-text/10"
                            }`}
                          >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-black shadow-md ${
                              isCorrect ? "bg-green-500 text-white" :
                              isWrong ? "bg-red-500 text-white" :
                              isSelected ? "bg-kids-accent text-kids-text" :
                              "bg-kids-text/5 text-kids-text/40"
                            }`}>
                              {index + 1}
                            </div>
                            
                            <div className="flex-1 flex items-center gap-4">
                              {optionImage && (
                                <img src={optionImage} className="w-16 h-16 rounded-xl object-cover border-2 border-kids-text/5" alt="" />
                              )}
                              <span className={`text-xl font-bold ${isSelected || isCorrect || isWrong ? "text-kids-text" : "text-kids-text/60"}`}>
                                {optionText}
                              </span>
                            </div>

                            <div className="ml-auto flex items-center gap-2">
                              {isCorrect && <CheckCircle2 className="text-green-500" size={32} />}
                              {isWrong && <XCircle className="text-red-500" size={32} />}
                              {isSelected && !feedback && (
                                <div className="w-12 h-12 rounded-full bg-kids-accent/20 flex items-center justify-center">
                                  <motion.div
                                    animate={{ scale: [1, 1.2, 1] }}
                                    transition={{ repeat: Infinity, duration: 1.5 }}
                                  >
                                    <Timer size={24} className="text-kids-text" />
                                  </motion.div>
                                </div>
                              )}
                            </div>
                            
                            {isSelected && !feedback && (
                              <div className="absolute bottom-0 left-0 h-2 bg-kids-accent transition-all duration-100 rounded-b-[1.25rem]" style={{ width: `${selectionProgress}%` }} />
                            )}
                          </motion.div>
                        );
                      })}
                    </div>
                  </motion.div>
                </>
              ) : (
                <div className="col-span-full text-center py-20">
                  <p className="text-kids-text/40 font-bold mb-4">No cards found! Add some in the Editor! ✨</p>
                  <button onClick={() => setMode('editor')} className="kids-btn kids-btn-primary">Go to Editor</button>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="editor-mode"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-8"
            >
              {/* Question List */}
              <div className="lg:col-span-1 space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto pr-2 custom-scrollbar">
                <div className="flex items-center justify-between mb-8">
                  <div className="flex items-center gap-4">
                    <button onClick={() => setMode('library')} className="p-3 bg-white rounded-2xl shadow-sm hover:bg-kids-secondary/10 transition-all border-2 border-kids-text/5">
                      <ChevronLeft size={24} className="text-kids-primary" />
                    </button>
                    <h2 className="text-2xl font-display font-black text-kids-text">Cards ({questions.length})</h2>
                  </div>
                  <button
                    onClick={addQuestion}
                    className="p-4 bg-kids-primary hover:bg-kids-primary/80 text-white rounded-2xl shadow-lg transition-all"
                  >
                    <Plus size={24} />
                  </button>
                </div>

                {selectedQuiz && (
                  <div className="kids-card border-kids-primary/20 mb-8 space-y-6">
                    <div className="space-y-3">
                      <label className="text-xs font-black uppercase tracking-widest text-kids-text/40">Game Title</label>
                      <input
                        type="text"
                        value={selectedQuiz.title}
                        onChange={async (e) => {
                          const newTitle = e.target.value;
                          setSelectedQuiz({ ...selectedQuiz, title: newTitle });
                          const quizRef = doc(db, 'quizzes', selectedQuiz.id);
                          await setDoc(quizRef, { title: newTitle }, { merge: true });
                        }}
                        className="w-full bg-kids-text/5 border-2 border-kids-text/5 rounded-2xl py-3 px-5 focus:border-kids-primary outline-none transition-all font-bold"
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-xs font-black uppercase tracking-widest text-kids-text/40">About this Game</label>
                      <textarea
                        value={selectedQuiz.description}
                        onChange={async (e) => {
                          const newDesc = e.target.value;
                          setSelectedQuiz({ ...selectedQuiz, description: newDesc });
                          const quizRef = doc(db, 'quizzes', selectedQuiz.id);
                          await setDoc(quizRef, { description: newDesc }, { merge: true });
                        }}
                        className="w-full bg-kids-text/5 border-2 border-kids-text/5 rounded-2xl py-3 px-5 focus:border-kids-primary outline-none transition-all font-medium min-h-[80px]"
                      />
                    </div>
                    <div className="flex flex-col gap-3">
                      <input
                        type="file"
                        accept=".xlsx, .xls"
                        className="hidden"
                        id="xlsx-upload-editor"
                        onChange={handleXlsxUpload}
                      />
                      <label
                        htmlFor="xlsx-upload-editor"
                        className="w-full py-3 bg-kids-secondary/10 hover:bg-kids-secondary/20 text-kids-secondary rounded-2xl text-sm font-black transition-all border-2 border-kids-secondary/10 flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <FileUp size={20} /> Import XLSX Cards
                      </label>
                      <button
                        onClick={() => setShowAiGenerator(true)}
                        className="w-full py-3 bg-kids-accent/10 hover:bg-kids-accent/20 text-kids-text rounded-2xl text-sm font-black transition-all border-2 border-kids-accent/10 flex items-center justify-center gap-2"
                      >
                        <Sparkles size={20} className="text-kids-accent" /> Generate with AI
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(selectedQuiz.id)}
                        className="w-full py-3 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-2xl text-sm font-black transition-all border-2 border-red-500/10"
                      >
                        Delete Game
                      </button>
                    </div>
                  </div>
                )}
                
                <div className="space-y-3">
                  {questions.map((q, idx) => (
                    <div
                      key={q.id}
                      onClick={() => setEditingQuestion(q)}
                      className={`p-5 rounded-2xl border-4 cursor-pointer transition-all ${editingQuestion?.id === q.id ? 'bg-kids-secondary/10 border-kids-secondary' : 'bg-white border-kids-text/5 hover:border-kids-text/10'}`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-4 overflow-hidden">
                          <span className="text-sm font-black text-kids-text/30">{idx + 1}</span>
                          <p className="text-base font-bold text-kids-text truncate">{q.text}</p>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteQuestion(q.id); }}
                          className="p-2 text-kids-text/20 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Edit Form */}
              <div className="lg:col-span-2">
                {editingQuestion ? (
                  <motion.div
                    key={editingQuestion.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="kids-card !p-10 border-kids-secondary/20 space-y-10"
                  >
                    <div className="space-y-8">
                      <div className="space-y-3">
                        <label className="text-sm font-black uppercase tracking-widest text-kids-text/40">Card Text</label>
                        <textarea
                          value={editingQuestion.text}
                          onChange={(e) => updateQuestion({ ...editingQuestion, text: e.target.value })}
                          onPaste={(e) => e.stopPropagation()}
                          className="w-full bg-kids-text/5 border-2 border-kids-text/5 rounded-2xl p-6 focus:border-kids-secondary outline-none transition-all min-h-[120px] text-kids-text font-bold text-xl"
                          placeholder="Enter your question..."
                        />
                      </div>

                      <div className="space-y-4">
                        <label className="text-sm font-black uppercase tracking-widest text-kids-text/40">Card Image</label>
                        <div className="flex flex-col gap-6">
                          {editingQuestion.imageUrl && (
                            <div className="relative aspect-video w-full max-w-md rounded-[2rem] overflow-hidden border-4 border-kids-text/5 group shadow-md">
                              <img src={editingQuestion.imageUrl} alt="Preview" className="w-full h-full object-cover" />
                              <button 
                                onClick={() => updateQuestion({ ...editingQuestion, imageUrl: undefined })}
                                className="absolute top-4 right-4 p-3 bg-red-500 text-white rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                              >
                                <Trash2 size={20} />
                              </button>
                            </div>
                          )}
                          <div className="flex flex-col sm:flex-row gap-4">
                            <input
                              type="file"
                              ref={fileInputRef}
                              onChange={handleImageUpload}
                              accept="image/*"
                              className="hidden"
                            />
                            <button
                              onClick={() => fileInputRef.current?.click()}
                              className="kids-btn kids-btn-secondary flex items-center justify-center gap-2 py-4 px-6 text-base"
                            >
                              <ImageIcon size={24} />
                              {editingQuestion.imageUrl ? "Change Picture" : "Add Picture"}
                            </button>
                            <div className="flex-1 relative">
                              <input
                                type="text"
                                value={editingQuestion.imageUrl || ""}
                                onChange={(e) => updateQuestion({ ...editingQuestion, imageUrl: e.target.value })}
                                className="w-full bg-kids-text/5 border-2 border-kids-text/5 rounded-2xl py-4 px-6 focus:border-kids-secondary outline-none transition-all font-bold text-kids-text/60"
                                placeholder="Or paste a magic link here..."
                              />
                            </div>
                          </div>
                          <p className="text-xs text-kids-text/30 font-bold italic">Max size: 1MB. Pictures are saved in your magic browser! ✨</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-8">
                        {editingQuestion.options.map((opt, idx) => {
                          const optObj = typeof opt === 'string' ? { text: opt } : opt;
                          return (
                            <div key={idx} className="p-8 bg-kids-text/5 border-4 border-kids-text/5 rounded-[2.5rem] space-y-6 transition-all hover:border-kids-secondary/20">
                              <div className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-4">
                                  <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center font-black text-kids-text text-xl shadow-sm border-2 border-kids-text/5">
                                    {idx + 1}
                                  </div>
                                  <label className="text-sm font-black uppercase tracking-widest text-kids-text/40">Option {idx + 1}</label>
                                </div>
                                <button
                                  onClick={() => updateQuestion({ ...editingQuestion, correctAnswer: idx })}
                                  className={`kids-btn text-sm py-2 px-6 ${editingQuestion.correctAnswer === idx ? 'kids-btn-primary' : 'bg-white border-2 border-kids-text/5 text-kids-text/30 hover:text-kids-text/60'}`}
                                >
                                  {editingQuestion.correctAnswer === idx ? 'Correct Answer! ✨' : 'Set as Correct'}
                                </button>
                              </div>
                              
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <div className="space-y-3">
                                  <label className="text-xs font-black uppercase tracking-widest text-kids-text/30">What it says</label>
                                  <input
                                    type="text"
                                    value={optObj.text}
                                    onChange={(e) => {
                                      const newOpts = [...editingQuestion.options];
                                      newOpts[idx] = { ...optObj, text: e.target.value };
                                      updateQuestion({ ...editingQuestion, options: newOpts });
                                    }}
                                    onPaste={(e) => e.stopPropagation()}
                                    className="w-full bg-white border-2 border-kids-text/5 rounded-2xl py-4 px-6 focus:border-kids-secondary outline-none transition-all font-bold text-kids-text"
                                    placeholder="Enter option text..."
                                  />
                                </div>
                                <div className="space-y-3">
                                  <label className="text-xs font-black uppercase tracking-widest text-kids-text/30">Option Picture (Optional)</label>
                                  <div className="flex gap-3">
                                    {optObj.imageUrl ? (
                                      <div className="relative w-14 h-14 rounded-2xl border-2 border-kids-text/5 overflow-hidden shrink-0 group shadow-sm">
                                        <img src={optObj.imageUrl} className="w-full h-full object-cover" />
                                        <button 
                                          onClick={() => {
                                            const newOpts = [...editingQuestion.options];
                                            newOpts[idx] = { ...optObj, imageUrl: undefined };
                                            updateQuestion({ ...editingQuestion, options: newOpts });
                                          }}
                                          className="absolute inset-0 bg-red-500/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white"
                                        >
                                          <Trash2 size={16} />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={() => {
                                          const input = document.createElement('input');
                                          input.type = 'file';
                                          input.accept = 'image/*';
                                          input.onchange = (e) => handleImageUpload(e as any, idx);
                                          input.click();
                                        }}
                                        className="w-14 h-14 rounded-2xl border-4 border-dashed border-kids-text/10 flex items-center justify-center text-kids-text/20 hover:text-kids-secondary hover:border-kids-secondary/40 transition-all shrink-0 bg-white"
                                      >
                                        <Plus size={20} />
                                      </button>
                                    )}
                                    <input
                                      type="text"
                                      value={optObj.imageUrl || ""}
                                      onChange={(e) => {
                                        const newOpts = [...editingQuestion.options];
                                        newOpts[idx] = { ...optObj, imageUrl: e.target.value };
                                        updateQuestion({ ...editingQuestion, options: newOpts });
                                      }}
                                      className="flex-1 bg-white border-2 border-kids-text/5 rounded-2xl py-4 px-6 focus:border-kids-secondary outline-none transition-all font-bold text-kids-text/40 text-xs"
                                      placeholder="Paste picture link..."
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row items-center justify-between gap-6 pt-10 border-t-4 border-kids-text/5">
                      <p className="text-sm text-kids-text/30 font-bold italic">Everything is saved automatically! ✨</p>
                      <button
                        onClick={() => setEditingQuestion(null)}
                        className="kids-btn kids-btn-primary w-full sm:w-auto px-10 py-4"
                      >
                        Done Editing
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center p-20 bg-white rounded-[3rem] border-4 border-kids-text/5 border-dashed">
                    <div className="w-24 h-24 bg-kids-text/5 rounded-[2rem] flex items-center justify-center mb-6 rotate-3">
                      <Settings className="text-kids-text/10" size={48} />
                    </div>
                    <h3 className="text-2xl font-display font-black text-kids-text/40 mb-2">Pick a Card to Edit!</h3>
                    <p className="text-lg font-bold text-kids-text/30 max-w-xs">Choose a card from the list or add a new one to make your game special! ✨</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none z-[-1] overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-kids-primary/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-kids-secondary/10 blur-[120px] rounded-full" />
        <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] bg-kids-accent/10 blur-[100px] rounded-full" />
      </div>

      {/* Camera Test Modal */}
      <AnimatePresence>
        {showCameraTest && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-kids-primary/40 backdrop-blur-xl"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white border-8 border-kids-accent rounded-[3rem] w-full max-w-2xl overflow-hidden shadow-2xl"
            >
              <div className="p-8 border-b-4 border-kids-text/5 flex items-center justify-between bg-kids-accent/10">
                <div>
                  <h2 className="text-3xl font-display font-black text-kids-text">Camera Magic Check! ✨</h2>
                  <p className="text-kids-text/60 font-bold">Let's make sure we can see your magic hands!</p>
                </div>
                <button 
                  onClick={() => setShowCameraTest(false)}
                  className="p-3 hover:bg-white rounded-2xl transition-all border-2 border-transparent hover:border-kids-text/10"
                >
                  <XCircle size={32} className="text-kids-text/20 hover:text-kids-text/60" />
                </button>
              </div>
              
              <div className="p-8 space-y-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-4">
                    <div className="aspect-video bg-kids-text rounded-[2rem] overflow-hidden border-4 border-kids-text/5 relative shadow-inner">
                      <Webcam
                        audio={false}
                        mirrored={true}
                        className="w-full h-full object-cover opacity-90"
                        onUserMedia={() => setIsCameraReady(true)}
                        onUserMediaError={() => setIsCameraReady(false)}
                        disablePictureInPicture={true}
                        forceScreenshotSourceSize={false}
                        imageSmoothing={true}
                        screenshotFormat="image/jpeg"
                        screenshotQuality={0.92}
                      />
                      {!isCameraReady && (
                        <div className="absolute inset-0 flex items-center justify-center bg-kids-text/10 backdrop-blur-sm">
                          <Camera size={48} className="text-white/40 animate-pulse" />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between px-6 py-4 bg-kids-text/5 rounded-2xl border-2 border-kids-text/5">
                      <span className="text-sm font-black uppercase tracking-widest text-kids-text/40">Magic Status</span>
                      <div className="flex items-center gap-3">
                        <div className={`w-3 h-3 rounded-full ${isCameraReady ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]'}`} />
                        <span className={`text-sm font-black uppercase ${isCameraReady ? 'text-green-500' : 'text-red-500'}`}>
                          {isCameraReady ? 'Active!' : 'Blocked!'}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="space-y-6">
                    <div className="space-y-4">
                      <h4 className="text-lg font-black text-kids-text">How to fix it:</h4>
                      <ul className="space-y-4">
                        <li className="flex gap-4 text-sm font-bold text-kids-text/70">
                          <div className="w-8 h-8 rounded-xl bg-kids-primary text-white flex items-center justify-center shrink-0 font-black shadow-sm">1</div>
                          <span>Click the <b>Lock 🔒</b> icon up top and turn on the <b>Camera</b>!</span>
                        </li>
                        <li className="flex gap-4 text-sm font-bold text-kids-text/70">
                          <div className="w-8 h-8 rounded-xl bg-kids-secondary text-white flex items-center justify-center shrink-0 font-black shadow-sm">2</div>
                          <span>Click the <b>Open in New Tab</b> button below to fix it fast!</span>
                        </li>
                        <li className="flex gap-4 text-sm font-bold text-kids-text/70">
                          <div className="w-8 h-8 rounded-xl bg-kids-accent text-kids-text flex items-center justify-center shrink-0 font-black shadow-sm">3</div>
                          <span>Make sure no other apps are using your camera!</span>
                        </li>
                      </ul>
                    </div>
                    
                    <div className="pt-4 space-y-3">
                      <button
                        onClick={async () => {
                          await requestCameraPermission();
                          if (isCameraReady && pendingQuiz) {
                            setSelectedQuiz(pendingQuiz);
                            setQuestions(pendingQuiz.questions);
                            setCurrentQuestionIndex(0);
                            setScore(0);
                            setIsQuizFinished(false);
                            setMode('quiz');
                            setPendingQuiz(null);
                            setShowCameraTest(false);
                          }
                        }}
                        className="kids-btn kids-btn-primary w-full py-4 text-base"
                      >
                        Try Requesting Permission
                      </button>
                      <button
                        onClick={() => window.open(window.location.href, '_blank')}
                        className="kids-btn kids-btn-secondary w-full py-4 text-base"
                      >
                        Open in New Tab (Fixes it!)
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(window.location.href);
                          setNotification({ message: "App URL copied! Paste it into a new tab to fix camera magic!", type: 'success' });
                        }}
                        className="w-full py-4 bg-kids-text/5 hover:bg-kids-text/10 rounded-2xl font-black text-sm transition-all text-kids-text/60 border-2 border-transparent hover:border-kids-text/5"
                      >
                        Copy App URL
                      </button>
                      <button
                        onClick={() => {
                          if (pendingQuiz) {
                            setSelectedQuiz(pendingQuiz);
                            setQuestions(pendingQuiz.questions);
                            setCurrentQuestionIndex(0);
                            setScore(0);
                            setIsQuizFinished(false);
                            setMode('quiz');
                            setPendingQuiz(null);
                          }
                          setShowCameraTest(false);
                        }}
                        className="w-full py-4 bg-kids-text/5 hover:bg-kids-text/10 rounded-2xl font-black text-sm transition-all text-kids-text/40 border-2 border-transparent hover:border-kids-text/5"
                      >
                        Play with Keyboard Only
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Generator Modal */}
      <AnimatePresence>
        {showAiGenerator && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-kids-primary/40 backdrop-blur-xl"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white border-8 border-kids-accent/20 rounded-[3rem] w-full max-w-md overflow-hidden shadow-2xl p-8"
            >
              <div className="w-20 h-20 bg-kids-accent/10 rounded-[2rem] flex items-center justify-center text-kids-accent mx-auto mb-6">
                <Sparkles size={40} />
              </div>
              <h2 className="text-3xl font-display font-black text-kids-text text-center mb-4">Magic AI Generator</h2>
              <p className="text-kids-text/60 font-bold text-center mb-8">Tell me a topic and I'll build the game! ✨</p>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-kids-text/40 ml-2">Topic & New Title</label>
                  <input
                    type="text"
                    value={aiTopic}
                    onChange={(e) => setAiTopic(e.target.value)}
                    placeholder="e.g., Solar System, Animal Kingdom"
                    className="w-full bg-kids-text/5 border-4 border-transparent rounded-2xl py-4 px-6 focus:border-kids-accent outline-none transition-all font-bold"
                  />
                </div>
                
                <div className="space-y-4">
                  <div className="flex justify-between items-center px-2">
                    <label className="text-xs font-black uppercase tracking-widest text-kids-text/40">Magic Question Count</label>
                    <span className="text-lg font-black text-kids-accent bg-kids-accent/10 px-4 py-1 rounded-full">{aiQuestionCount}</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="50"
                    step="5"
                    value={aiQuestionCount}
                    onChange={(e) => setAiQuestionCount(parseInt(e.target.value))}
                    className="w-full accent-kids-accent h-2 bg-kids-text/10 rounded-full appearance-none cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] font-black text-kids-text/20 uppercase tracking-widest px-1">
                    <span>Few</span>
                    <span>Lots!</span>
                  </div>
                </div>

                <div className="flex flex-col gap-3 pt-4">
                  <button
                    onClick={generateAiQuestions}
                    disabled={isGenerating || !aiTopic.trim()}
                    className={`kids-btn kids-btn-primary w-full py-4 text-lg flex items-center justify-center gap-3 ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="animate-spin" size={24} />
                        Generating Magic...
                      </>
                    ) : (
                      <>
                        <Sparkles size={24} />
                        Generate Now!
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => setShowAiGenerator(false)}
                    disabled={isGenerating}
                    className="w-full py-4 bg-kids-text/5 hover:bg-kids-text/10 rounded-2xl font-black text-sm transition-all text-kids-text/40 border-2 border-transparent"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteConfirmId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-kids-primary/40 backdrop-blur-xl"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white border-8 border-red-500/20 rounded-[3rem] w-full max-w-md overflow-hidden shadow-2xl p-8 text-center"
            >
              <div className="w-20 h-20 bg-red-500/10 rounded-[2rem] flex items-center justify-center text-red-500 mx-auto mb-6">
                <Trash2 size={40} />
              </div>
              <h2 className="text-3xl font-display font-black text-kids-text mb-4">Are you sure?</h2>
              <p className="text-kids-text/60 font-bold mb-8">This will delete your magic game forever! You can't undo this. ✨</p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => deleteQuiz(deleteConfirmId)}
                  className="kids-btn bg-red-500 text-white hover:bg-red-600 w-full py-4 text-lg"
                >
                  Yes, Delete It!
                </button>
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="w-full py-4 bg-kids-text/5 hover:bg-kids-text/10 rounded-2xl font-black text-sm transition-all text-kids-text/40 border-2 border-transparent"
                >
                  No, Keep It!
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Notifications */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className={`fixed bottom-8 left-1/2 -translate-x-1/2 z-[300] px-8 py-4 rounded-full shadow-2xl border-4 flex items-center gap-4 ${
              notification.type === 'success' 
                ? 'bg-white border-kids-primary text-kids-primary' 
                : 'bg-white border-red-500 text-red-500'
            }`}
          >
            {notification.type === 'success' ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
            <span className="text-lg font-black">{notification.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}</style>
    </div>
  );
}
