import { NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import path from 'path';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const audioBlob = formData.get('audio') as Blob;
    const metadata = formData.get('metadata') as string;

    if (!audioBlob) {
      return NextResponse.json(
        { error: 'No audio data received' },
        { status: 400 }
      );
    }

    // Create unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `audio-${timestamp}.webm`;
    
    // Save to uploads directory
    const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
    const buffer = Buffer.from(await audioBlob.arrayBuffer());
    await writeFile(path.join(uploadsDir, filename), buffer);

    return NextResponse.json({ 
      success: true,
      filename,
      url: `/uploads/${filename}`
    });
  } catch (error) {
    console.error('Error handling audio upload:', error);
    return NextResponse.json(
      { error: 'Failed to process audio' },
      { status: 500 }
    );
  }
} 