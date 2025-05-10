import AudioRecorder from './components/AudioRecorder';

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-100 py-12">
      <div className="container mx-auto px-4">
        <h1 className="text-4xl font-bold text-center mb-8 text-gray-800">
          Audio Recorder
        </h1>
        <AudioRecorder />
      </div>
    </main>
  );
} 