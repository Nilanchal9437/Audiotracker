'use client';

import { useState, useRef, useEffect, ChangeEvent } from 'react';

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
    console.log('Environment detection:', { isMac, isSafari, userAgent: navigator.userAgent });

    try {
      setPermissionError(null);
      setShowPermissionModal(false);

      // Browser-specific audio constraints
      const audioConstraints = {
        audio: {
          // Safari/Mac specific settings
          ...(isSafari || isMac ? {
            echoCancellation: true,    // Enable for Safari stability
            noiseSuppression: true,    // Enable for Safari stability
            autoGainControl: true,     // Enable for Safari stability
            channelCount: 1,           // Mono for Safari
            sampleRate: 44100,         // Standard rate for Safari
          } : {
            // Windows/Chrome settings
            echoCancellation: false,   // Capture background noise
            noiseSuppression: false,   // Preserve background sounds
            autoGainControl: false,    // Manual gain control
            channelCount: 2,           // Stereo
            sampleRate: 48000,         // Higher quality
            sampleSize: 24            // Better depth
          })
        }
      };

      console.log('Using audio constraints:', audioConstraints);

      // Request audio with browser-specific constraints
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);

      // Initialize audio context with browser-specific settings
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (audioContextRef.current) {
        try {
          await audioContextRef.current.close();
        } catch (err) {
          console.error('Error closing previous audio context:', err);
        }
      }

      audioContextRef.current = new AudioContext({
        sampleRate: (isSafari || isMac) ? 44100 : 48000,
        latencyHint: (isSafari || isMac) ? 'playback' : 'interactive'
      });

      // Create and configure audio nodes
      audioSourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.gain.value = (isSafari || isMac) ? 1.5 : gainValue;
      audioDestinationRef.current = audioContextRef.current.createMediaStreamDestination();

      // Connect audio graph
      audioSourceRef.current
        .connect(gainNodeRef.current)
        .connect(audioDestinationRef.current);

      // Determine supported mime types
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
          mimeType = 'audio/ogg;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        }
      }

      const options = {
        mimeType,
        bitsPerSecond: (isSafari || isMac) ? 128000 : 256000
      };

      console.log('MediaRecorder options:', options);

      const mediaRecorder = new MediaRecorder(audioDestinationRef.current.stream, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event);
        stopRecording();
        setPermissionError('Recording error occurred. Please try again.');
        setShowPermissionModal(true);
      };

      mediaRecorder.onstop = () => {
        try {
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
          const audioUrl = URL.createObjectURL(audioBlob);
          setAudioData({ blob: audioBlob, url: audioUrl });
          
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
          setPermissionError('Error finishing recording. Please try again.');
          setShowPermissionModal(true);
        }
      };

      // Use larger chunks for Safari/Mac
      mediaRecorder.start((isSafari || isMac) ? 100 : 50);
      setIsRecording(true);

    } catch (error: unknown) {
      console.error('Error accessing audio:', error);
      
      let errorMessage = 'An unknown error occurred while trying to access audio.';
      
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          errorMessage = isMac 
            ? 'Please check System Preferences > Security & Privacy > Microphone and ensure browser access is enabled.'
            : 'Permission to record audio was denied. Please grant permission to continue.';
        } else if (error.name === 'NotSupportedError') {
          errorMessage = isMac
            ? 'Please use Safari 14+ or latest Chrome on your Mac.'
            : 'Please use Chrome or Edge on Windows.';
        } else if (error.message) {
          errorMessage = error.message;
        }
      }
      
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