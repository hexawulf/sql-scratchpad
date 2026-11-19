interface FilePickerWindow extends Window {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{ getFile: () => Promise<File> }[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

export async function openSqlFile(): Promise<{ name: string; content: string } | null> {
  const win = window as FilePickerWindow;
  if (typeof win.showOpenFilePicker === 'function') {
    try {
      const handles = await win.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'SQL files', accept: { 'application/sql': ['.sql', '.txt'] } }],
      });
      const first = handles[0];
      if (!first) return null;
      const file = await first.getFile();
      return { name: file.name, content: await file.text() };
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return null;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sql,.txt,text/plain,application/sql';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      resolve({ name: file.name, content: await file.text() });
    };
    input.click();
  });
}

export async function saveSqlFile(filename: string, content: string): Promise<boolean> {
  const safeName = filename.endsWith('.sql') ? filename : `${filename}.sql`;
  const win = window as FilePickerWindow;
  if (typeof win.showSaveFilePicker === 'function') {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName: safeName,
        types: [{ description: 'SQL files', accept: { 'application/sql': ['.sql'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return true;
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return false;
    }
  }

  const blob = new Blob([content], { type: 'application/sql;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
