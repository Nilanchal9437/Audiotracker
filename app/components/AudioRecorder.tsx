'use client';

import { useState, useRef, useEffect, ChangeEvent } from 'react';
import posthog, { PostHog } from 'posthog-js';

// Initialize PostHog with feature flags
if (typeof window !== 'undefined') {
  posthog.init('phc_4W7WQxZcdY5qSao5UnHg2dGaDUOFwfAgQ9DCqXinonQ', {
    api_host: 'https://app.posthog.com',
    loaded: (loadedPostHog: PostHog) => {
      if (process.env.NODE_ENV === 'development') loadedPostHog.debug();
    },
    persistence: 'localStorage',
    bootstrap: {
      distinctID: 'user-' + Date.now()
    }
  });
}

interface AudioData {
  blob: Blob;
  url: string;
  timestamp: number;
  deviceInfo: any;
}

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

export default function AudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [audioData, setAudioData] = useState<AudioData | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [gainValue, setGainValue] = useState(1.5); // Default gain boost
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioBufferSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingSessionRef = useRef<string>('');

  useEffect(() => {
    return () => {
      if (audioData?.url) {
        URL.revokeObjectURL(audioData.url);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, [audioData]);

  // Function to generate a unique session ID
  const generateSessionId = () => {
    return 'rec-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  };

  const requestPermission = async () => {
    const sessionId = generateSessionId();
    recordingSessionRef.current = sessionId;

    const deviceInfo = {
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      vendor: navigator.vendor,
      isMac: /Mac/.test(navigator.platform),
      isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
      isChrome: /Chrome/.test(navigator.userAgent),
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      sessionId
    };

    try {
      // Start PostHog recording session
      posthog.startSessionRecording();
      
      posthog.capture('audio_recording_session_start', {
        sessionId,
        deviceInfo,
        timestamp: Date.now()
      });

      setPermissionError(null);
      setShowPermissionModal(false);

      // Request audio permissions
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100,
        }
      });

      posthog.capture('audio_permission_granted', {
        sessionId,
        deviceInfo
      });

      // Initialize Web Audio API
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContextRef.current = new AudioContext();

      // Create audio processing pipeline
      const source = audioContextRef.current.createMediaStreamSource(stream);
      const gainNode = audioContextRef.current.createGain();
      const destination = audioContextRef.current.createMediaStreamDestination();
      
      // Create audio processor for real-time analysis
      const processor = audioContextRef.current.createScriptProcessor(2048, 1, 1);
      
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate audio levels using Array.from for TypeScript compatibility
        const dataArray = Array.from(inputData);
        const sum = dataArray.reduce((acc, val) => acc + Math.abs(val), 0);
        const average = sum / dataArray.length;
        
        // Send audio metrics to PostHog
        posthog.capture('audio_levels', {
          sessionId,
          average,
          peak: Math.max(...dataArray),
          timestamp: Date.now()
        });
      };

      // Connect nodes
      source
        .connect(gainNode)
        .connect(processor)
        .connect(destination);
      processor.connect(audioContextRef.current.destination);

      // Store refs
      audioSourceRef.current = source;
      gainNodeRef.current = gainNode;
      audioDestinationRef.current = destination;

      // Configure MediaRecorder
      const options = {
        mimeType: 'audio/webm;codecs=opus',
        bitsPerSecond: 128000
      };

      const mediaRecorder = new MediaRecorder(destination.stream, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          
          // Send chunk to PostHog
          const chunk = await event.data.arrayBuffer();
          posthog.capture('audio_chunk', {
            sessionId,
            chunkSize: event.data.size,
            chunkData: Array.from(new Uint8Array(chunk)),
            timestamp: Date.now()
          });
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const audioUrl = URL.createObjectURL(audioBlob);
        
        // Store audio data with metadata
        const audioMetadata: AudioData = {
          blob: audioBlob,
          url: audioUrl,
          timestamp: Date.now(),
          deviceInfo
        };
        
        setAudioData(audioMetadata);

        // Send complete recording to PostHog
        const audioBuffer = await audioBlob.arrayBuffer();
        posthog.capture('recording_completed', {
          sessionId,
          audioData: Array.from(new Uint8Array(audioBuffer)),
          duration: Date.now() - recordingStartTime,
          metadata: audioMetadata
        });

        // Cleanup
        if (audioContextRef.current) {
          audioSourceRef.current?.disconnect();
          gainNodeRef.current?.disconnect();
          processor.disconnect();
          audioContextRef.current.close();
          audioContextRef.current = null;
        }

        stream.getTracks().forEach(track => track.stop());
        posthog.stopSessionRecording();
      };

      const recordingStartTime = Date.now();
      mediaRecorder.start(100);
      setIsRecording(true);

    } catch (error) {
      console.error('Recording error:', error);
      
      posthog.capture('recording_error', {
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        deviceInfo,
        timestamp: Date.now()
      });

      let errorMessage = 'An error occurred while trying to record audio.';
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          errorMessage = 'Please grant microphone permission to record audio.';
        } else if (error.name === 'NotFoundError') {
          errorMessage = 'No microphone found. Please check your audio settings.';
        }
      }

      setPermissionError(errorMessage);
      setShowPermissionModal(true);
      posthog.stopSessionRecording();
    }
  };

  const adjustGain = (e: ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    setGainValue(value);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = value;
    }
  };

  const startRecording = () => {
    setShowPermissionModal(true);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const playRecording = async () => {
    if (!audioData) return;

    try {
      const sessionId = generateSessionId();
      posthog.capture('playback_started', {
        sessionId,
        originalRecordingSession: recordingSessionRef.current,
        timestamp: Date.now()
      });

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }

      const response = await fetch(audioData.url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);

      if (audioBufferSourceRef.current) {
        audioBufferSourceRef.current.stop();
      }

      const source = audioContextRef.current.createBufferSource();
      source.buffer = audioBuffer;
      
      // Create analyzer for playback monitoring
      const analyzer = audioContextRef.current.createAnalyser();
      analyzer.fftSize = 2048;
      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      source.connect(analyzer);
      analyzer.connect(audioContextRef.current.destination);

      // Monitor playback and send metrics to PostHog
      const monitorPlayback = () => {
        if (!isPlaying) return;
        
        analyzer.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((acc, val) => acc + val, 0) / bufferLength;
        
        posthog.capture('playback_metrics', {
          sessionId,
          average,
          timestamp: Date.now()
        });

        requestAnimationFrame(monitorPlayback);
      };

      source.onended = () => {
        setIsPlaying(false);
        posthog.capture('playback_completed', {
          sessionId,
          timestamp: Date.now()
        });
      };
      
      audioBufferSourceRef.current = source;
      source.start(0);
      setIsPlaying(true);
      monitorPlayback();

    } catch (error) {
      console.error('Playback error:', error);
      posthog.capture('playback_error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
      alert('Error playing the recording. Please try again.');
    }
  };

  const stopPlayback = () => {
    if (audioBufferSourceRef.current) {
      audioBufferSourceRef.current.stop();
      setIsPlaying(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 p-6 bg-white rounded-lg shadow-lg relative">
      {showPermissionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl max-w-md w-full mx-4">
            <h3 className="text-xl font-bold mb-4">Audio Permission Required</h3>
            {permissionError ? (
              <div>
                <p className="text-red-500 mb-4">{permissionError}</p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowPermissionModal(false)}
                    className="px-4 py-2 text-gray-600 hover:text-gray-800"
                  >
                    Close
                  </button>
                  <button
                    onClick={requestPermission}
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                  >
                    Try Again
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-4">
                  To record audio, you&apos;ll need to:
                </div>
                <ol className="list-decimal ml-6 mb-4">
                  <li>Click &quot;Allow&quot; when prompted for microphone access</li>
                  <li>Make sure your microphone is working and not muted</li>
                  <li>Stay on this page while recording</li>
                </ol>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowPermissionModal(false)}
                    className="px-4 py-2 text-gray-600 hover:text-gray-800"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={requestPermission}
                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <h2 className="text-2xl font-bold text-gray-800">Audio Recorder</h2>
      <p className="text-sm text-gray-600 text-center mb-4">
        Record audio including background sounds. Adjust sensitivity using the slider below.
      </p>
      
      <div className="w-full max-w-xs mb-4">
        <label htmlFor="gain-control" className="block text-sm font-medium text-gray-700 mb-1">
          Microphone Sensitivity
        </label>
        <input
          id="gain-control"
          type="range"
          min={0.5}
          max={4}
          step={0.5}
          value={gainValue}
          onChange={adjustGain}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
          disabled={isRecording}
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>Low</span>
          <span>High</span>
        </div>
      </div>

      <div className="flex gap-4">
        {!isRecording ? (
          <button
            onClick={startRecording}
            className="px-6 py-2 text-white bg-red-500 rounded-full hover:bg-red-600 transition-colors"
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="px-6 py-2 text-white bg-gray-500 rounded-full hover:bg-gray-600 transition-colors"
          >
            Stop Recording
          </button>
        )}

        {audioData && (
          <>
            {!isPlaying ? (
              <button
                onClick={playRecording}
                className="px-6 py-2 text-white bg-green-500 rounded-full hover:bg-green-600 transition-colors"
              >
                Play Recording
              </button>
            ) : (
              <button
                onClick={stopPlayback}
                className="px-6 py-2 text-white bg-gray-500 rounded-full hover:bg-gray-600 transition-colors"
              >
                Stop Playback
              </button>
            )}
          </>
        )}
      </div>

      <div className="mt-4">
        {isRecording && (
          <div className="flex items-center gap-2 text-red-500">
            <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
            Recording...
          </div>
        )}
      </div>
    </div>
  );
} 