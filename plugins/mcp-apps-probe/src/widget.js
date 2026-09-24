import { App } from '@modelcontextprotocol/ext-apps';

const count = document.getElementById('count');
const button = document.getElementById('increment');
const status = document.getElementById('status');
const app = new App({ name: 'MCP Apps quiet-action probe', version: '0.1.0' });

function applyResult(result) {
  const value = result?.structuredContent?.count;
  if (Number.isSafeInteger(value) && value >= 0) count.textContent = String(value);
}

app.ontoolresult = applyResult;
app.onerror = (error) => { status.textContent = `Host error: ${error.message ?? String(error)}`; };

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Calling the server tool…';
  try {
    const result = await app.callServerTool({ name: 'increment_probe', arguments: {} });
    if (result.isError) throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? 'Tool failed');
    applyResult(result);
    status.textContent = 'Counter updated. Check whether a new chat message appeared.';
  } catch (error) {
    status.textContent = `Tool call failed: ${error.message ?? String(error)}`;
  } finally {
    button.disabled = false;
  }
});

async function connect() {
  try {
    await app.connect();
    if (app.getHostCapabilities()?.serverTools) {
      button.disabled = false;
      status.textContent = 'Ready. Click once to test a quiet server action.';
    } else {
      status.textContent = 'This host did not advertise direct server tool calls.';
    }
  } catch (error) {
    status.textContent = `MCP Apps connection failed: ${error.message ?? String(error)}`;
  }
}

void connect();
