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

  // Add OS detection
  const [isMacOS, setIsMacOS] = useState(false);

  // Add OS version detection
  const [macOSVersion, setMacOSVersion] = useState<string | null>(null);

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

  useEffect(() => {
    // Detect if running on macOS
    setIsMacOS(navigator.platform.toUpperCase().indexOf('MAC') >= 0);
  }, []);

  useEffect(() => {
    // Detect macOS version
    const detectMacOSVersion = () => {
      const userAgent = window.navigator.userAgent;
      const macOSMatch = userAgent.match(/Mac OS X (\d+[._]\d+[._]\d+)/);
      if (macOSMatch) {
        const version = macOSMatch[1].replace(/_/g, '.');
        setMacOSVersion(version);
      }
      setIsMacOS(navigator.platform.toUpperCase().indexOf('MAC') >= 0);
    };

    detectMacOSVersion();
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

    // Calculate RMS value for better level representation
    const rms = Math.sqrt(
      dataArray.reduce((acc, val) => acc + (val * val), 0) / dataArray.length
    );
    
    // Convert to percentage with some headroom
    const level = Math.min(100, (rms / 128) * 100);
    setAudioLevel(level);

    animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
  };

  // Get audio stream based on mode
  const getAudioStream = async () => {
    switch (recordingMode) {
      case 'microphone':
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            // Disable audio processing to capture raw audio including background noise
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // High quality audio settings
            channelCount: 2,
            sampleRate: 48000,
            sampleSize: 24
          }
        });
        micStreamRef.current = micStream;

        // Set up audio context for microphone
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const audioContext = new AudioContextClass({
          sampleRate: 48000,
          latencyHint: 'interactive'
        });

        // Create audio source from microphone
        const source = audioContext.createMediaStreamSource(micStream);
        const destination = audioContext.createMediaStreamDestination();

        // Create gain node with higher gain to pick up background sounds
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 2.0; // Increase gain to capture quieter sounds

        // Create a gentle compressor to balance loud and quiet sounds
        const compressor = audioContext.createDynamicsCompressor();
        compressor.threshold.value = -50; // Lower threshold to catch quiet sounds
        compressor.knee.value = 40; // Soft knee for natural sound
        compressor.ratio.value = 4; // Gentle compression
        compressor.attack.value = 0.001;
        compressor.release.value = 0.2;

        // Create analyzer for visualizing audio levels
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 4096;
        analyser.minDecibels = -90; // Lower minimum to catch quiet sounds
        analyser.maxDecibels = -10;
        analyser.smoothingTimeConstant = 0.85;

        // Connect the audio processing chain
        source.connect(compressor);
        compressor.connect(gainNode);
        gainNode.connect(destination);
        gainNode.connect(analyser);

        analyserRef.current = analyser;
        audioContextRef.current = audioContext;

        return destination.stream;

      case 'system':
        try {
          console.log('Requesting system audio access...');
          
          // First check if we have necessary permissions
          try {
            const permissionStatus = await navigator.permissions.query({ name: 'display-capture' as PermissionName });
            console.log('Screen capture permission status:', permissionStatus.state);
          } catch (err) {
            console.log('Permission query not supported, proceeding with request:', err);
          }

          // Request system audio with detailed error handling
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: {
              // Optimize for system audio capture
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              // High quality audio settings
              sampleRate: 48000,
              sampleSize: 24,
              channelCount: 2
            },
            video: {
              // Minimal video settings
              width: 1,
              height: 1,
              frameRate: 1,
              displaySurface: 'monitor'
            }
          }).catch((err) => {
            console.error('Display media request failed:', err);
            if (err.name === 'NotAllowedError') {
              throw new Error(
                'System audio permission denied. Please follow these steps:\n\n' +
                '1. Browser Settings:\n' +
                '   - Click the lock/info icon in the address bar\n' +
                '   - Go to Site Settings\n' +
                '   - Allow screen sharing and audio permissions\n' +
                '   - Refresh the page\n\n' +
                '2. When the sharing popup appears:\n' +
                '   - Select "Screen" tab (not Window/Tab)\n' +
                '   - Choose "Entire Screen"\n' +
                '   - IMPORTANT: Check "Share system audio" box\n\n' +
                '3. If still not working:\n' +
                '   - Check browser settings > Privacy & Security\n' +
                '   - Look for "Screen Sharing" or "Media" permissions\n' +
                '   - Make sure system audio sharing is enabled\n' +
                '   - Try using Chrome or Edge for best compatibility'
              );
            } else if (err.name === 'NotFoundError') {
              throw new Error('No audio source found. Please check your system audio settings.');
            } else if (err.name === 'NotReadableError') {
              throw new Error('Could not access system audio. Try closing other applications using audio capture.');
            }
            throw err;
          });

          console.log('Display media stream obtained:', displayStream);
          
          // Verify audio tracks
          const audioTracks = displayStream.getAudioTracks();
          console.log('Audio tracks available:', audioTracks.length);
          
          // Log detailed track information
          audioTracks.forEach((track, index) => {
            console.log(`Audio track ${index} details:`, {
              label: track.label,
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
              settings: track.getSettings()
            });

            // Ensure track is enabled
            track.enabled = true;
            
            // Add track event listeners
            track.onended = () => {
              console.log('Audio track ended');
              stopRecording();
            };
            
            track.onmute = () => {
              console.warn('Audio track muted');
              setError('System audio was muted. Please check your audio settings.');
            };
            
            track.onunmute = () => {
              console.log('Audio track unmuted');
              setError(null);
            };
          });

          const audioTrack = audioTracks[0];
          if (!audioTrack) {
            displayStream.getTracks().forEach(track => track.stop());
            throw new Error(
              'System audio capture failed. Please check:\n\n' +
              '1. System Audio:\n' +
              '   - Make sure audio is playing on your system\n' +
              '   - Check system volume is not muted\n' +
              '   - Try playing a YouTube video or music\n\n' +
              '2. Sharing Settings:\n' +
              '   - "Share system audio" must be checked\n' +
              '   - Select "Entire Screen" option\n' +
              '   - Use "Screen" tab in sharing dialog\n\n' +
              '3. Browser Settings:\n' +
              '   - Allow screen sharing permission\n' +
              '   - Enable system audio capture\n' +
              '   - Try Chrome or Edge browser'
            );
          }

          // Create audio context with error handling
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          const audioContext = new AudioContextClass({
            sampleRate: 48000,
            latencyHint: 'playback'
          });

          // Resume audio context if needed
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
          }
          
          console.log('Audio context state:', audioContext.state);

          // Create and configure audio processing chain
          const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
          const destination = audioContext.createMediaStreamDestination();
          
          // Add compressor for better audio quality
          const compressor = audioContext.createDynamicsCompressor();
          compressor.threshold.value = -24;
          compressor.knee.value = 30;
          compressor.ratio.value = 12;
          compressor.attack.value = 0.003;
          compressor.release.value = 0.25;
          
          // Add gain control
          const gainNode = audioContext.createGain();
          gainNode.gain.value = 1.5; // Increased gain for better audibility
          
          // Add filter to reduce noise
          const filter = audioContext.createBiquadFilter();
          filter.type = 'highpass';
          filter.frequency.value = 50;
          
          // Connect the audio processing chain
          source.connect(filter);
          filter.connect(compressor);
          compressor.connect(gainNode);
          gainNode.connect(destination);
          
          // Set up analyzer for audio levels
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 4096;
          analyser.minDecibels = -90;
          analyser.maxDecibels = -10;
          analyser.smoothingTimeConstant = 0.85;
          
          gainNode.connect(analyser);
          analyserRef.current = analyser;
          
          // Store refs for cleanup
          audioContextRef.current = audioContext;
          systemStreamRef.current = new MediaStream([audioTrack]);

          // Stop video track to save resources
          displayStream.getVideoTracks().forEach(track => track.stop());

          console.log('System audio capture setup complete');
          return destination.stream;

        } catch (err) {
          console.error('System audio capture error:', err);
          if (err instanceof Error) {
            if (err.name === 'NotAllowedError') {
              throw new Error(
                'Permission denied. Please try:\n\n' +
                '1. Allow screen sharing when prompted\n' +
                '2. Make sure "Share system audio" is checked\n' +
                '3. If denied accidentally:\n' +
                '   - Click the camera icon in address bar\n' +
                '   - Reset permissions and try again\n' +
                '4. Check browser settings for media permissions'
              );
            } else if (err.name === 'NotReadableError') {
              throw new Error(
                'Could not access system audio. Please try:\n\n' +
                '1. Close other apps using audio capture\n' +
                '2. Refresh the page\n' +
                '3. Restart the browser if issue persists'
              );
            }
          }
          throw err;
        }

      case 'both':
        try {
          // Get microphone stream with settings for background noise
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              // Disable processing to capture background noise
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2,
              sampleRate: 48000,
              sampleSize: 24
            }
          });
          micStreamRef.current = micStream;
          console.log('Microphone stream obtained with background noise enabled:', micStream);

          // Get system audio stream
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: {
              // Disable processing for system audio
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2,
              sampleRate: 48000,
              sampleSize: 24
            },
            video: {
              width: 1,
              height: 1,
              frameRate: 1,
              displaySurface: 'monitor'
            }
          });

          const systemAudioTrack = displayStream.getAudioTracks()[0];
          if (!systemAudioTrack) {
            displayStream.getTracks().forEach(track => track.stop());
            throw new Error('No system audio detected. Please make sure to check "Share system audio".');
          }

          // Create audio context for mixing
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          const audioContext = new AudioContextClass({
            sampleRate: 48000,
            latencyHint: 'interactive'
          });

          // Create sources for both streams
          const micSource = audioContext.createMediaStreamSource(micStream);
          const systemSource = audioContext.createMediaStreamSource(new MediaStream([systemAudioTrack]));

          // Create processing nodes for microphone
          const micCompressor = audioContext.createDynamicsCompressor();
          micCompressor.threshold.value = -24;
          micCompressor.knee.value = 30;
          micCompressor.ratio.value = 12;
          micCompressor.attack.value = 0.003;
          micCompressor.release.value = 0.25;

          // Create processing nodes for system audio
          const systemCompressor = audioContext.createDynamicsCompressor();
          systemCompressor.threshold.value = -24;
          systemCompressor.knee.value = 30;
          systemCompressor.ratio.value = 12;
          systemCompressor.attack.value = 0.003;
          systemCompressor.release.value = 0.25;

          // Create gain nodes for level control
          const micGain = audioContext.createGain();
          const systemGain = audioContext.createGain();
          micGain.gain.value = 0.7;    // Slightly reduce mic volume
          systemGain.gain.value = 0.8;  // Slightly reduce system volume

          // Create filters for both sources
          const micFilter = audioContext.createBiquadFilter();
          micFilter.type = 'highpass';
          micFilter.frequency.value = 80; // Cut very low frequencies

          const systemFilter = audioContext.createBiquadFilter();
          systemFilter.type = 'highpass';
          systemFilter.frequency.value = 50; // Cut very low frequencies

          // Create a limiter for the final output
          const masterLimiter = audioContext.createDynamicsCompressor();
          masterLimiter.threshold.value = -3.0;
          masterLimiter.knee.value = 0.0;
          masterLimiter.ratio.value = 20.0;
          masterLimiter.attack.value = 0.001;
          masterLimiter.release.value = 0.1;

          // Create merger for combining both sources
          const merger = audioContext.createChannelMerger(2);

          // Connect microphone processing chain
          micSource.connect(micFilter);
          micFilter.connect(micCompressor);
          micCompressor.connect(micGain);
          micGain.connect(merger, 0, 0);

          // Connect system audio processing chain
          systemSource.connect(systemFilter);
          systemFilter.connect(systemCompressor);
          systemCompressor.connect(systemGain);
          systemGain.connect(merger, 0, 1);

          // Create destination
          const destination = audioContext.createMediaStreamDestination();

          // Connect merger to limiter and then to destination
          merger.connect(masterLimiter);
          masterLimiter.connect(destination);

          // Set up analyzer
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 4096;
          analyser.minDecibels = -90;
          analyser.maxDecibels = -10;
          analyser.smoothingTimeConstant = 0.85;

          masterLimiter.connect(analyser);
          analyserRef.current = analyser;

          // Store refs for cleanup
          audioContextRef.current = audioContext;
          systemStreamRef.current = new MediaStream([systemAudioTrack]);

          // Stop video track
          displayStream.getVideoTracks().forEach(track => track.stop());

          console.log('Successfully set up mixed audio stream');
          return destination.stream;

        } catch (err) {
          console.error('Combined audio capture error:', err);
          if (err instanceof Error && err.name === 'NotAllowedError') {
            throw new Error(
              'Permission denied for combined recording. Please follow these steps:\n\n' +
              '1. Microphone Setup:\n' +
              '   - Allow microphone access in browser settings\n' +
              '   - Check if microphone is working in system settings\n' +
              '   - Make sure no other app is using the microphone\n\n' +
              '2. System Audio Setup:\n' +
              '   - Set appropriate system volume (50-75%)\n' +
              '   - Ensure audio output is working\n' +
              '   - Try playing some audio to verify\n\n' +
              '3. Browser Settings:\n' +
              '   - Allow both microphone and screen capture permissions\n' +
              '   - Enable system audio sharing in browser settings\n\n' +
              '4. When Sharing Screen:\n' +
              '   - Select "Screen" tab\n' +
              '   - Choose "Entire Screen"\n' +
              '   - Check "Share system audio" box\n' +
              '   - Grant both mic and screen permissions when prompted'
            );
          }
          throw err;
        }

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

  // Add instructions component
  const MacOSInstructions = () => {
    if (!isMacOS) return null;

    const isNewMacOS = macOSVersion && parseFloat(macOSVersion) >= 14.4;

    return (
      <div className="w-full p-4 mb-4 bg-blue-100 text-blue-800 rounded">
        <h3 className="font-bold mb-2">macOS System Audio Setup</h3>
        {isNewMacOS ? (
          <>
            <p className="mb-2">Your macOS version ({macOSVersion}) supports native system audio capture:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Open System Settings → Privacy & Security → Screen Recording</li>
              <li>Enable permission for your browser</li>
              <li>Restart your browser after enabling permissions</li>
              <li>When sharing, select "Screen" and enable "Share system audio"</li>
            </ol>
          </>
        ) : (
          <>
            <p className="mb-2">For macOS {macOSVersion}, you'll need a virtual audio driver:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Install BlackHole or Background Music audio driver</li>
              <li>Open System Settings → Sound</li>
              <li>Set Output to BlackHole/Background Music</li>
              <li>Set Input to BlackHole/Background Music</li>
              <li>When sharing, select "Screen" and your virtual audio device</li>
            </ol>
            <p className="mt-2 text-sm">
              <a 
                href="https://github.com/ExistentialAudio/BlackHole" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline"
              >
                Download BlackHole
              </a>
              {' or '}
              <a 
                href="https://github.com/kyleneideck/BackgroundMusic" 
                target="_blank" 
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline"
              >
                Download Background Music
              </a>
            </p>
          </>
        )}
      </div>
    );
  };

  // Modify system audio capture logic
  const getSystemAudioStream = async () => {
    if (isMacOS) {
      const isNewMacOS = macOSVersion && parseFloat(macOSVersion) >= 14.4;
      console.log(`Requesting system audio on macOS ${macOSVersion}`);

      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            sampleSize: 24,
            channelCount: 2
          },
          video: {
            width: 1,
            height: 1,
            frameRate: 1,
            displaySurface: 'monitor'
          }
        });

        const audioTrack = displayStream.getAudioTracks()[0];
        if (!audioTrack) {
          displayStream.getTracks().forEach(track => track.stop());
          throw new Error(
            `System audio capture failed on macOS ${macOSVersion}.\n\n` +
            (isNewMacOS ? 
              '1. Enable Screen Recording Permission:\n' +
              '   - Open System Settings → Privacy & Security\n' +
              '   - Enable Screen Recording for your browser\n' +
              '   - Restart your browser\n\n' +
              '2. When Sharing Screen:\n' +
              '   - Choose "Screen" tab\n' +
              '   - Select "Entire Screen"\n' +
              '   - Enable "Share system audio"\n\n' +
              '3. Audio Settings:\n' +
              '   - Check system volume is not muted\n' +
              '   - Play some audio to verify it works' :
              '1. Install Virtual Audio Driver:\n' +
              '   - Download and install BlackHole or Background Music\n' +
              '   - Follow driver setup instructions\n\n' +
              '2. Configure System Audio:\n' +
              '   - Open System Settings → Sound\n' +
              '   - Set Output to virtual audio device\n' +
              '   - Set Input to virtual audio device\n\n' +
              '3. When Sharing Screen:\n' +
              '   - Choose "Screen" tab\n' +
              '   - Select "Entire Screen"\n' +
              '   - Select your virtual audio device')
          );
        }

        return displayStream;
      } catch (err) {
        console.error('System audio capture error:', err);
        throw err;
      }
    } else {
      // Non-macOS system audio capture logic
      return navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          sampleSize: 24,
          channelCount: 2
        },
        video: {
          width: 1,
          height: 1,
          frameRate: 1,
          displaySurface: 'monitor'
        }
      });
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-4">Audio Recorder</h2>

      {/* Add MacOS Instructions component */}
      {(recordingMode === 'system' || recordingMode === 'both') && <MacOSInstructions />}

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

          {/* Error display with better formatting */}
          {error && (
            <div className="w-full p-4 mb-4 bg-red-100 text-red-700 rounded">
              <p className="font-medium">Error:</p>
              {error.split('\n').map((line, index) => (
                <p key={index} className={index === 0 ? 'mb-2' : 'ml-4 text-sm'}>
                  {line}
                </p>
              ))}
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