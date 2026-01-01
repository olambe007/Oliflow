
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SUPPORTED_LANGUAGES, TranslationRecord, Language } from './types';
import { decode, decodeAudioData, createBlob } from './services/audioUtils';

// Basic offline dictionary for common travel phrases
const OFFLINE_DICTIONARY: Record<string, Record<string, string>> = {
  'fr-en': {
    "bonjour": "hello",
    "merci": "thank you",
    "s'il vous plaît": "please",
    "où est la gare ?": "where is the station?",
    "je suis perdu": "i am lost",
    "combien ça coûte ?": "how much does it cost?",
    "santé !": "cheers!",
    "oui": "yes",
    "non": "no",
    "pardon": "excuse me"
  },
  'en-fr': {
    "hello": "bonjour",
    "thank you": "merci",
    "please": "s'il vous plaît",
    "where is the station?": "où est la gare ?",
    "i am lost": "je suis perdu",
    "how much does it cost?": "combien ça coûte ?",
    "cheers!": "santé !",
    "yes": "oui",
    "no": "non",
    "excuse me": "pardon"
  }
};

const Waveform = ({ active, isOffline }: { active: boolean; isOffline?: boolean }) => (
  <div className="flex items-center justify-center gap-1.5 h-16">
    {[...Array(12)].map((_, i) => (
      <div
        key={i}
        className={`w-1.5 rounded-full transition-all duration-300 ${
          active ? 'animate-pulse' : 'h-2 opacity-20'
        } ${isOffline ? 'bg-orange-400' : 'bg-blue-500'}`}
        style={{
          height: active ? `${Math.random() * 40 + 10}px` : '6px',
          transitionDelay: `${i * 50}ms`
        }}
      />
    ))}
  </div>
);

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'translate' | 'history'>('translate');
  const [fromLang, setFromLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [toLang, setToLang] = useState<Language>(SUPPORTED_LANGUAGES[1]);
  const [isListening, setIsListening] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [manualOffline, setManualOffline] = useState(false);
  const [history, setHistory] = useState<TranslationRecord[]>([]);
  const [currentTranscription, setCurrentTranscription] = useState({ user: '', model: '' });
  
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);

  const isActuallyOffline = !isOnline || manualOffline;

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    const saved = localStorage.getItem('lingoflow_history');
    if (saved) setHistory(JSON.parse(saved));

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('lingoflow_history', JSON.stringify(history));
  }, [history]);

  const stopAllAudio = () => {
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  // --- Offline Logic ---
  const handleOfflineTranslate = (text: string) => {
    const pair = `${fromLang.code}-${toLang.code}`;
    const normalizedText = text.toLowerCase().trim();
    let translated = OFFLINE_DICTIONARY[pair]?.[normalizedText];

    if (!translated) {
      translated = `[Offline] "${text}"`;
    }

    setCurrentTranscription({ user: text, model: translated });
    
    // Voice feedback offline using browser built-in TTS
    const utterance = new SpeechSynthesisUtterance(translated);
    utterance.lang = toLang.code;
    window.speechSynthesis.speak(utterance);

    // Save to history
    const newRecord: TranslationRecord = {
      id: Date.now().toString(),
      originalText: text,
      translatedText: translated,
      fromLang: fromLang.code,
      toLang: toLang.code,
      timestamp: Date.now(),
    };
    setHistory(h => [newRecord, ...h].slice(0, 50));
  };

  const startOfflineListening = () => {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) {
      alert("Reconnaissance vocale non supportée sur cet appareil en mode hors ligne.");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = fromLang.code;
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0])
        .map((result: any) => result.transcript)
        .join('');
      setCurrentTranscription(prev => ({ ...prev, user: transcript }));
      
      if (event.results[0].isFinal) {
        handleOfflineTranslate(transcript);
        stopSession();
      }
    };

    recognition.onerror = () => stopSession();
    recognition.onend = () => setIsListening(false);
    
    recognitionRef.current = recognition;
    recognition.start();
  };

  // --- Gemini Online Logic ---
  const startSession = async () => {
    if (isActuallyOffline) {
      startOfflineListening();
      return;
    }

    if (!process.env.API_KEY) {
      alert("Clé API manquante.");
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: toLang.voice as any } },
          },
          systemInstruction: `Tu es un interprète professionnel. L'utilisateur parle en ${fromLang.name}. Traduis tout ce qu'il dit en ${toLang.name}. NE PARLE QUE LA TRADUCTION. Sois direct et précis.`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              setCurrentTranscription(prev => ({ ...prev, user: prev.user + text }));
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              setCurrentTranscription(prev => ({ ...prev, model: prev.model + text }));
            }

            if (message.serverContent?.turnComplete) {
              setCurrentTranscription(prev => {
                if (prev.user && prev.model) {
                  const newRecord: TranslationRecord = {
                    id: Date.now().toString(),
                    originalText: prev.user,
                    translatedText: prev.model,
                    fromLang: fromLang.code,
                    toLang: toLang.code,
                    timestamp: Date.now(),
                  };
                  setHistory(h => [newRecord, ...h].slice(0, 50));
                }
                return { user: '', model: '' };
              });
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              const audioCtx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), audioCtx, 24000, 1);
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(audioCtx.destination);
              
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              stopAllAudio();
            }
          },
          onerror: (e) => console.error('Gemini Error:', e),
          onclose: () => setIsListening(false),
        }
      });

      sessionRef.current = await sessionPromise;
      setIsListening(true);
    } catch (err) {
      console.error("Erreur session:", err);
      alert("Erreur de connexion. Vérifiez votre micro.");
    }
  };

  const stopSession = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
    }
    stopAllAudio();
    setIsListening(false);
    if (!isActuallyOffline) {
      setCurrentTranscription({ user: '', model: '' });
    }
  };

  const toggleTranslation = () => {
    if (isListening) stopSession();
    else startSession();
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#f2f2f7]">
      {/* Header optimisé iOS */}
      <header className="safe-top bg-white/80 ios-blur border-b border-gray-200">
        <div className="px-6 py-4 flex justify-between items-center">
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">LingoFlow</h1>
            {isActuallyOffline && (
              <span className="text-[9px] font-bold text-orange-500 uppercase tracking-widest block -mt-1">Mode Hors Ligne</span>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={() => {
                if (isListening) stopSession();
                setManualOffline(!manualOffline);
              }}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full transition-all border ${
                manualOffline 
                  ? 'bg-orange-500 border-orange-500 text-white' 
                  : 'bg-white border-gray-200 text-gray-400'
              }`}
            >
              <i className={`fa-solid ${manualOffline ? 'fa-plane' : 'fa-wifi'} text-[10px]`}></i>
              <span className="text-[10px] font-bold uppercase tracking-widest">Offline</span>
            </button>

            <div className={`px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-widest ${isActuallyOffline ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600'}`}>
              {isActuallyOffline ? 'Limité' : 'En Direct'}
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto px-4 py-6 pb-24">
        {activeTab === 'translate' ? (
          <div className="space-y-6 animate-in fade-in duration-500">
            {/* Lang Selection */}
            <div className="bg-white rounded-[2rem] p-5 shadow-sm border border-gray-100 flex items-center justify-between">
              <button onClick={() => !isListening && setFromLang(SUPPORTED_LANGUAGES[(SUPPORTED_LANGUAGES.indexOf(fromLang) + 1) % SUPPORTED_LANGUAGES.length])} className="flex-1 flex flex-col items-center">
                <span className="text-4xl mb-1">{fromLang.flag}</span>
                <span className="text-xs font-bold text-gray-400 uppercase">{fromLang.name}</span>
              </button>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${isActuallyOffline ? 'bg-orange-50 text-orange-200' : 'bg-gray-50 text-gray-300'}`}>
                <i className="fa-solid fa-arrow-right-long"></i>
              </div>
              <button onClick={() => !isListening && setToLang(SUPPORTED_LANGUAGES[(SUPPORTED_LANGUAGES.indexOf(toLang) + 1) % SUPPORTED_LANGUAGES.length])} className="flex-1 flex flex-col items-center">
                <span className="text-4xl mb-1">{toLang.flag}</span>
                <span className={`text-xs font-bold uppercase ${isActuallyOffline ? 'text-orange-500' : 'text-blue-500'}`}>{toLang.name}</span>
              </button>
            </div>

            {/* Visualizer & Text Area */}
            <div className={`min-h-[320px] bg-white rounded-[2.5rem] p-8 shadow-sm border border-gray-100 flex flex-col items-center justify-center transition-all ${isListening ? (isActuallyOffline ? 'ring-4 ring-orange-500/10 scale-[1.02]' : 'ring-4 ring-blue-500/10 scale-[1.02]') : ''}`}>
              {!isListening && !currentTranscription.user ? (
                <div className="text-center space-y-4 opacity-40">
                  <div className={`w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-4 ${isActuallyOffline ? 'bg-orange-50' : 'bg-blue-50'}`}>
                    <i className={`fa-solid fa-microphone text-4xl ${isActuallyOffline ? 'text-orange-500' : 'text-blue-500'}`}></i>
                  </div>
                  <p className="font-semibold text-lg">{isActuallyOffline ? 'Mode Hors Ligne' : 'Prêt à traduire'}</p>
                  <p className="text-sm px-4">{isActuallyOffline ? 'Traduction de phrases de base uniquement' : 'Parlez naturellement, la traduction est instantanée'}</p>
                </div>
              ) : (
                <div className="w-full h-full flex flex-col">
                  <Waveform active={isListening} isOffline={isActuallyOffline} />
                  <div className="flex-1 mt-8 space-y-6 text-left overflow-y-auto max-h-[220px]">
                    {currentTranscription.user && (
                      <div className="animate-in slide-in-from-left-4 fade-in">
                        <p className={`text-[10px] font-black uppercase mb-1 tracking-tighter ${isActuallyOffline ? 'text-orange-200' : 'text-gray-300'}`}>SOURCE</p>
                        <p className="text-lg text-gray-700 font-medium leading-tight">{currentTranscription.user}</p>
                      </div>
                    )}
                    {currentTranscription.model && (
                      <div className="animate-in slide-in-from-right-4 fade-in">
                        <p className={`text-[10px] font-black uppercase mb-1 tracking-tighter ${isActuallyOffline ? 'text-orange-400' : 'text-blue-400'}`}>TRADUCTION</p>
                        <p className={`text-2xl font-bold leading-tight italic ${isActuallyOffline ? 'text-orange-600' : 'text-blue-600'}`}>"{currentTranscription.model}"</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Mic Button */}
            <div className="flex flex-col items-center pt-2">
              <button
                onClick={toggleTranslation}
                className={`w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all active:scale-90 duration-500 ${
                  isListening 
                    ? 'bg-red-500 text-white animate-pulse' 
                    : (isActuallyOffline ? 'bg-orange-500 text-white' : 'bg-blue-600 text-white')
                }`}
              >
                <i className={`fa-solid ${isListening ? 'fa-stop text-3xl' : 'fa-microphone text-4xl'}`}></i>
              </button>
              <p className={`mt-4 text-xs font-bold uppercase tracking-widest ${isListening ? 'text-red-500' : 'text-gray-400'}`}>
                {isListening ? 'Écoute en cours...' : 'Touchez pour parler'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 animate-in fade-in duration-500">
            <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-2 mb-2">Historique récent</h2>
            {history.length === 0 ? (
              <div className="py-20 text-center text-gray-300">
                <i className="fa-solid fa-clock-rotate-left text-6xl mb-4 opacity-10"></i>
                <p className="font-medium">Aucune traduction récente</p>
              </div>
            ) : (
              history.map((item) => (
                <div key={item.id} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 flex flex-col gap-2">
                   <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-black text-blue-500 uppercase">{item.fromLang}</span>
                      <i className="fa-solid fa-chevron-right text-[8px] text-gray-300"></i>
                      <span className="text-[10px] font-black text-blue-500 uppercase">{item.toLang}</span>
                    </div>
                    <span className="text-[10px] text-gray-300">{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <p className="text-gray-500 text-sm leading-snug">{item.originalText}</p>
                  <p className="text-blue-600 font-bold text-base leading-snug">{item.translatedText}</p>
                </div>
              ))
            )}
          </div>
        )}
      </main>

      {/* Tab Bar optimisé iOS */}
      <nav className="safe-bottom fixed bottom-0 left-0 right-0 bg-white/80 ios-blur border-t border-gray-100 px-10 h-24 flex justify-between items-center z-50">
        <button onClick={() => setActiveTab('translate')} className={`flex flex-col items-center gap-1.5 transition-all ${activeTab === 'translate' ? 'text-blue-600 scale-110' : 'text-gray-300'}`}>
          <i className="fa-solid fa-comment-dots text-2xl"></i>
          <span className="text-[9px] font-black uppercase tracking-tighter">Traduire</span>
        </button>
        <button onClick={() => setActiveTab('history')} className={`flex flex-col items-center gap-1.5 transition-all ${activeTab === 'history' ? 'text-blue-600 scale-110' : 'text-gray-300'}`}>
          <i className="fa-solid fa-clock-rotate-left text-2xl"></i>
          <span className="text-[9px] font-black uppercase tracking-tighter">Historique</span>
        </button>
      </nav>
    </div>
  );
};

export default App;
