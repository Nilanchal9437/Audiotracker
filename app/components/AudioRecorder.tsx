'use client';

import { useState, useRef, useEffect, ChangeEvent } from 'react';
import posthog, { PostHog } from 'posthog-js';

// Initialize PostHog
if (typeof window !== 'undefined') {
  posthog.init('phc_4W7WQxZcdY5qSao5UnHg2dGaDUOFwfAgQ9DCqXinonQ', {
    api_host: 'https://app.posthog.com',
    loaded: (loadedPostHog: PostHog) => {
      if (process.env.NODE_ENV === 'development') loadedPostHog.debug();
    }
  });
}

interface AudioData {
  blob: Blob;
  url: string;
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

  const requestPermission = async () => {
    // Platform and browser detection
    const isMac = /Mac/.test(navigator.platform);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isChrome = /Chrome/.test(navigator.userAgent);
    
    const browserInfo = {
      isMac,
      isSafari,
      isChrome,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor
    };

    posthog.capture('audio_recording_attempt', browserInfo);

    try {
      setPermissionError(null);
      setShowPermissionModal(false);

      // First try to get audio permission with basic constraints
      try {
        const initialStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        initialStream.getTracks().forEach(track => track.stop());
        posthog.capture('basic_permission_granted', browserInfo);
      } catch (permError) {
        posthog.capture('basic_permission_error', {
          error: permError instanceof Error ? permError.message : 'Unknown error',
          ...browserInfo
        });
        throw permError;
      }

      // Mac-specific audio constraints
      const macConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 44100,
        }
      };

      // Windows/Chrome constraints
      const defaultConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 24
        }
      };

      // Try Mac-specific constraints first if on Mac
      let stream;
      let usedConstraints;
      
      if (isMac) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(macConstraints);
          usedConstraints = macConstraints;
          posthog.capture('mac_constraints_success', { constraints: macConstraints, ...browserInfo });
        } catch (macError) {
          posthog.capture('mac_constraints_failed', {
            error: macError instanceof Error ? macError.message : 'Unknown error',
            constraints: macConstraints,
            ...browserInfo
          });
          // Fallback to default constraints
          stream = await navigator.mediaDevices.getUserMedia(defaultConstraints);
          usedConstraints = defaultConstraints;
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia(defaultConstraints);
        usedConstraints = defaultConstraints;
      }

      posthog.capture('audio_stream_created', {
        constraints: usedConstraints,
        ...browserInfo
      });

      // Initialize audio context
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) {
        throw new Error('WebAudio API not supported');
      }

      // Close existing audio context if any
      if (audioContextRef.current) {
        try {
          await audioContextRef.current.close();
        } catch (err) {
          console.error('Error closing previous audio context:', err);
        }
      }

      // Create new audio context with platform-specific settings
      audioContextRef.current = new AudioContext({
        sampleRate: isMac ? 44100 : 48000,
        latencyHint: isMac ? 'playback' : 'interactive'
      });

      // Wait for audio context to be ready
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      // Set up audio processing chain
      audioSourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.gain.value = isMac ? 1.8 : gainValue;
      audioDestinationRef.current = audioContextRef.current.createMediaStreamDestination();

      // Add a compressor node for better audio quality
      const compressor = audioContextRef.current.createDynamicsCompressor();
      compressor.threshold.value = -50;
      compressor.knee.value = 40;
      compressor.ratio.value = 12;
      compressor.attack.value = 0;
      compressor.release.value = 0.25;

      // Connect audio graph with compressor
      audioSourceRef.current
        .connect(gainNodeRef.current)
        .connect(compressor)
        .connect(audioDestinationRef.current);

      posthog.capture('audio_processing_chain_created', { ...browserInfo });

      // Determine best supported format
      const formats = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4;codecs=opus',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/ogg',
        'audio/wav'
      ];

      let selectedFormat = formats.find(format => MediaRecorder.isTypeSupported(format));
      
      if (!selectedFormat) {
        posthog.capture('no_supported_format', browserInfo);
        throw new Error('No supported audio format found');
      }

      posthog.capture('format_selected', { format: selectedFormat, ...browserInfo });

      // Create MediaRecorder with selected format
      const mediaRecorder = new MediaRecorder(audioDestinationRef.current.stream, {
        mimeType: selectedFormat,
        bitsPerSecond: isMac ? 128000 : 256000
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      let recordingStartTime = Date.now();
      let lastChunkTime = recordingStartTime;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          const now = Date.now();
          audioChunksRef.current.push(event.data);
          posthog.capture('chunk_received', {
            chunkSize: event.data.size,
            chunkDuration: now - lastChunkTime,
            totalDuration: now - recordingStartTime,
            totalChunks: audioChunksRef.current.length,
            ...browserInfo
          });
          lastChunkTime = now;
        }
      };

      mediaRecorder.onerror = (event) => {
        posthog.capture('recorder_error', {
          error: event.error?.message || 'Unknown error',
          ...browserInfo
        });
        stopRecording();
        setPermissionError('Recording error occurred. Please try again.');
        setShowPermissionModal(true);
      };

      mediaRecorder.onstop = () => {
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: selectedFormat });
          const audioUrl = URL.createObjectURL(audioBlob);
          setAudioData({ blob: audioBlob, url: audioUrl });

          posthog.capture('recording_completed', {
            duration: Date.now() - recordingStartTime,
            fileSize: audioBlob.size,
            format: selectedFormat,
            ...browserInfo
          });

          // Cleanup
          if (audioContextRef.current) {
            audioSourceRef.current?.disconnect();
            gainNodeRef.current?.disconnect();
            audioContextRef.current.close().catch(console.error);
            audioContextRef.current = null;
          }

          stream.getTracks().forEach(track => track.stop());
        } catch (error) {
          console.error('Error in onstop handler:', error);
          posthog.capture('completion_error', {
            error: error instanceof Error ? error.message : 'Unknown error',
            ...browserInfo
          });
          setPermissionError('Error finishing recording. Please try again.');
          setShowPermissionModal(true);
        }
      };

      // Start recording with platform-specific settings
      const chunkSize = isMac ? 100 : 50;
      mediaRecorder.start(chunkSize);
      setIsRecording(true);
      
      posthog.capture('recording_started', {
        format: selectedFormat,
        chunkSize,
        ...browserInfo
      });

    } catch (error: unknown) {
      console.error('Error accessing audio:', error);
      
      let errorMessage = 'An unknown error occurred while trying to access audio.';
      let errorType = 'unknown_error';
      
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          errorType = 'permission_denied';
          errorMessage = isMac 
            ? 'Please open System Preferences > Security & Privacy > Privacy > Microphone and ensure your browser is enabled.'
            : 'Permission to record audio was denied. Please grant permission to continue.';
        } else if (error.name === 'NotSupportedError') {
          errorType = 'browser_not_supported';
          errorMessage = isMac
            ? 'Please try using Safari 14+ or the latest version of Chrome on your Mac.'
            : 'Please use Chrome or Edge on Windows.';
        } else if (error.name === 'NotReadableError' || error.name === 'NotFoundError') {
          errorType = 'device_error';
          errorMessage = 'Unable to access your microphone. Please check your microphone connection and settings.';
        } else {
          errorType = error.name;
          errorMessage = error.message;
        }
      }
      
      posthog.capture('setup_error', {
        errorType,
        errorMessage,
        error: error instanceof Error ? error.message : 'Unknown error',
        ...browserInfo
      });
      
      setPermissionError(errorMessage);
      setShowPermissionModal(true);
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
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const response = await fetch(audioData.url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);

      if (audioBufferSourceRef.current) {
        audioBufferSourceRef.current.stop();
      }

      const source = audioContextRef.current.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContextRef.current.destination);
      source.onended = () => setIsPlaying(false);
      
      audioBufferSourceRef.current = source;
      source.start(0);
      setIsPlaying(true);
    } catch (error) {
      console.error('Error playing audio:', error);
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