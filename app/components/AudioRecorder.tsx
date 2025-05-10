'use client';

import { useState, useRef, useEffect } from 'react';

export default function AudioRecorder() {
  // Basic states
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingMode, setRecordingMode] = useState<'microphone' | 'system' | 'both'>('microphone');

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Add browser API check
  const [isBrowserSupported, setIsBrowserSupported] = useState(false);

  useEffect(() => {
    // Check for browser support
    const checkBrowserSupport = () => {
      const hasMediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
      const hasMediaRecorder = typeof window !== 'undefined' && 'MediaRecorder' in window;
      const hasAudioContext = typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window);
      
      setIsBrowserSupported(hasMediaDevices && hasMediaRecorder && hasAudioContext);
    };

    checkBrowserSupport();
  }, []);

  // Cleanup function
  useEffect(() => {
    return () => {
      stopRecording();
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (systemStreamRef.current) {
        systemStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioRef.current?.src) {
        URL.revokeObjectURL(audioRef.current.src);
      }
    };
  }, []);

  const updateAudioLevel = () => {
    if (!analyserRef.current || !isRecording) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    // Calculate average volume level
    const average = dataArray.reduce((acc, val) => acc + val, 0) / dataArray.length;
    setAudioLevel((average / 255) * 100);

    animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
  };

  // Get combined audio stream
  const getCombinedAudioStream = async () => {
    if (!isBrowserSupported) {
      throw new Error('Your browser does not support audio recording');
    }

    try {
      // Create audio context
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;

      // Get microphone stream
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      micStreamRef.current = micStream;

      // Get system audio stream
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: {
          width: 1,
          height: 1,
          frameRate: 1
        }
      });

      const systemAudioTrack = displayStream.getAudioTracks()[0];
      if (!systemAudioTrack) {
        throw new Error('No system audio selected. Please make sure to check "Share audio".');
      }

      // Create a new stream with only the system audio track
      const systemStream = new MediaStream([systemAudioTrack]);
      systemStreamRef.current = systemStream;

      // Stop the video track
      displayStream.getVideoTracks().forEach(track => track.stop());

      // Create audio sources and merger
      const micSource = audioContext.createMediaStreamSource(micStream);
      const systemSource = audioContext.createMediaStreamSource(systemStream);
      const merger = audioContext.createChannelMerger(2);

      // Connect sources to merger
      micSource.connect(merger, 0, 0);
      systemSource.connect(merger, 0, 1);

      // Create analyzer for audio levels
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      merger.connect(analyser);
      analyserRef.current = analyser;

      // Create MediaStream from merged audio
      const dest = audioContext.createMediaStreamDestination();
      merger.connect(dest);

      return dest.stream;

    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          throw new Error('Access was denied. Please allow both microphone and system audio access.');
        } else if (err.name === 'NotSupportedError') {
          throw new Error('Combined audio recording is not supported in your browser. Please try using Chrome or Edge.');
        }
      }
      throw err;
    }
  };

  // Get audio stream based on mode
  const getAudioStream = async () => {
    switch (recordingMode) {
      case 'microphone':
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        micStreamRef.current = micStream;
        return micStream;

      case 'system':
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: {
            width: 1,
            height: 1,
            frameRate: 1
          }
        });

        const audioTrack = displayStream.getAudioTracks()[0];
        if (!audioTrack) {
          displayStream.getTracks().forEach(track => track.stop());
          throw new Error('No system audio was selected. Please select a tab or window with audio and make sure to check "Share audio".');
        }

        const systemStream = new MediaStream([audioTrack]);
        systemStreamRef.current = systemStream;
        
        displayStream.getVideoTracks().forEach(track => track.stop());
        return systemStream;

      case 'both':
        return getCombinedAudioStream();

      default:
        throw new Error('Invalid recording mode');
    }
  };

  // Start recording function
  const startRecording = async () => {
    console.log('Starting recording...');
    try {
      setError(null);
      chunksRef.current = [];

      if (!isBrowserSupported) {
        throw new Error('Your browser does not support audio recording');
      }

      console.log(`Requesting ${recordingMode} access...`);
      const stream = await getAudioStream();
      console.log('Audio access granted');

      try {
        // Create MediaRecorder with default settings
        const recorder = new MediaRecorder(stream);
        
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data);
            console.log('Audio chunk received:', e.data.size, 'bytes');
          }
        };

        recorder.onstart = () => {
          console.log('Recording started successfully');
          setIsRecording(true);
          setError(null);
          // Start audio level monitoring
          updateAudioLevel();
        };

        recorder.onstop = () => {
          console.log('Recording stopped, processing audio...');
          if (chunksRef.current.length === 0) {
            setError('No audio data was recorded');
            return;
          }

          try {
            const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
            console.log('Created audio blob:', audioBlob.size, 'bytes,', 'type:', audioBlob.type);
            const audioUrl = URL.createObjectURL(audioBlob);
            
            if (audioRef.current) {
              if (audioRef.current.src) {
                URL.revokeObjectURL(audioRef.current.src);
              }
              audioRef.current.src = audioUrl;
              setHasRecording(true);
            }
          } catch (err) {
            console.error('Error creating audio blob:', err);
            setError('Failed to process recorded audio');
            return;
          }

          // Clean up
          if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
          }
          if (micStreamRef.current) {
            micStreamRef.current.getTracks().forEach(track => track.stop());
          }
          if (systemStreamRef.current) {
            systemStreamRef.current.getTracks().forEach(track => track.stop());
          }
          setAudioLevel(0);
          setIsRecording(false);
        };

        recorder.onerror = (event) => {
          console.error('MediaRecorder error:', event);
          setError(`Recording error: ${event.error?.message || 'Unknown error'}`);
          setIsRecording(false);
          setAudioLevel(0);
          if (micStreamRef.current) {
            micStreamRef.current.getTracks().forEach(track => track.stop());
          }
          if (systemStreamRef.current) {
            systemStreamRef.current.getTracks().forEach(track => track.stop());
          }
        };

        mediaRecorderRef.current = recorder;
        console.log('Starting MediaRecorder with settings:', {
          mimeType: recorder.mimeType,
          state: recorder.state
        });
        
        recorder.start(100); // Collect data every 100ms for more frequent updates

      } catch (err) {
        console.error('Error creating MediaRecorder:', err);
        throw new Error(`Failed to create audio recorder: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }

    } catch (err) {
      console.error('Error starting recording:', err);
      setError(err instanceof Error ? err.message : 'Failed to start recording');
      setIsRecording(false);
      setAudioLevel(0);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (systemStreamRef.current) {
        systemStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    }
  };

  // Stop recording function
  const stopRecording = () => {
    console.log('Stopping recording...');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Play audio function
  const playAudio = () => {
    console.log('Playing audio...');
    if (!audioRef.current?.src) {
      setError('No recording available to play');
      return;
    }

    audioRef.current.play()
      .then(() => {
        console.log('Audio playback started');
        setIsPlaying(true);
        setError(null);
      })
      .catch((err) => {
        console.error('Playback error:', err);
        setError('Failed to play audio: ' + (err instanceof Error ? err.message : 'Unknown error'));
        setIsPlaying(false);
      });
  };

  // Stop audio function
  const stopAudio = () => {
    console.log('Stopping audio...');
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-4">Audio Recorder</h2>

      {!isBrowserSupported ? (
        <div className="w-full p-4 mb-4 bg-yellow-100 text-yellow-800 rounded">
          <p className="font-medium">Browser Not Supported</p>
          <p>Your browser does not support audio recording. Please use a modern browser like Chrome or Edge.</p>
        </div>
      ) : (
        <>
          {/* Recording mode selector */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setRecordingMode('microphone')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                recordingMode === 'microphone'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
              disabled={isRecording}
            >
              Microphone
            </button>
            <button
              onClick={() => setRecordingMode('system')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                recordingMode === 'system'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
              disabled={isRecording}
            >
              System Audio
            </button>
            <button
              onClick={() => setRecordingMode('both')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                recordingMode === 'both'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
              disabled={isRecording}
            >
              Both
            </button>
          </div>

          {/* Error display */}
          {error && (
            <div className="w-full p-4 mb-4 bg-red-100 text-red-700 rounded">
              <p className="font-medium">Error:</p>
              <p>{error}</p>
              {error.includes('denied') && (
                <p className="mt-2 text-sm">
                  Tip: Look for the {recordingMode === 'microphone' ? 'microphone' : 'screen share'} icon in your browser's address bar to grant permission.
                </p>
              )}
            </div>
          )}

          {/* Audio level meter */}
          <div className="w-full max-w-md mb-4">
            <div className="h-2 bg-gray-200 rounded overflow-hidden">
              <div 
                className="h-full bg-green-500 transition-all duration-100"
                style={{ width: `${audioLevel}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>Audio Level</span>
              <span>{Math.round(audioLevel)}%</span>
            </div>
          </div>

          {/* Control buttons */}
          <div className="flex gap-4">
            <button
              onClick={isRecording ? stopRecording : startRecording}
              className={`px-6 py-2 rounded-full text-white font-semibold transition-colors ${
                isRecording 
                  ? 'bg-red-500 hover:bg-red-600' 
                  : 'bg-blue-500 hover:bg-blue-600'
              }`}
              disabled={isPlaying}
            >
              {isRecording ? 'Stop Recording' : `Start ${recordingMode} Recording`}
            </button>

            {hasRecording && !isRecording && (
              <button
                onClick={isPlaying ? stopAudio : playAudio}
                className={`px-6 py-2 rounded-full text-white font-semibold transition-colors ${
                  isPlaying 
                    ? 'bg-yellow-500 hover:bg-yellow-600' 
                    : 'bg-green-500 hover:bg-green-600'
                }`}
              >
                {isPlaying ? 'Stop Playing' : 'Play Recording'}
              </button>
            )}
          </div>

          {/* Status indicators */}
          <div className="mt-4 text-sm">
            {isRecording && (
              <div className="flex items-center gap-2 text-red-500">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                Recording {recordingMode} audio...
              </div>
            )}
            {isPlaying && (
              <div className="flex items-center gap-2 text-green-500">
                <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                Playing recording...
              </div>
            )}
          </div>

          {/* Hidden audio element */}
          <audio
            ref={audioRef}
            style={{ display: 'none' }}
            onEnded={() => {
              console.log('Audio playback ended');
              setIsPlaying(false);
            }}
            onError={(e) => {
              const error = e.currentTarget.error;
              console.error('Audio element error:', error);
              setError(`Audio playback error: ${error?.message || 'Unknown error'}`);
              setIsPlaying(false);
            }}
          />
        </>
      )}
    </div>
  );
} 