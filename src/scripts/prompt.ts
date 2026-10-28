import readline from 'node:readline';

export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(question)) w.call(rl, s);
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}
