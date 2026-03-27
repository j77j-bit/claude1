const readline = require('readline');
const OpenAI = require('openai');

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('エラー: OPENAI_API_KEY 環境変数が設定されていません。');
  console.error('例: export OPENAI_API_KEY=your-api-key');
  process.exit(1);
}

const client = new OpenAI({ apiKey });

const messages = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('ChatGPT CLI へようこそ！');
console.log('終了するには "quit" または "exit" と入力してください。\n');

function prompt() {
  rl.question('あなた: ', async (input) => {
    const text = input.trim();

    if (!text) {
      prompt();
      return;
    }

    if (text === 'quit' || text === 'exit') {
      console.log('終了します。');
      rl.close();
      return;
    }

    messages.push({ role: 'user', content: text });

    try {
      process.stdout.write('ChatGPT: ');

      const stream = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        stream: true,
      });

      let assistantMessage = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        process.stdout.write(delta);
        assistantMessage += delta;
      }
      console.log('\n');

      messages.push({ role: 'assistant', content: assistantMessage });
    } catch (err) {
      console.error('\nエラーが発生しました:', err.message);
    }

    prompt();
  });
}

prompt();
