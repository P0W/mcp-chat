const messages = [
  { role: "user", content: "foo" },
  { role: "assistant", toolCalls: [{id: "1", name: "t1"}, {id: "2", name: "t2"}] },
  { role: "tool", toolCallId: "1", content: "r1" },
  { role: "tool", toolCallId: "2", content: "r2" }
];

const aMessages: any[] = [];
for (const m of messages) {
  if (m.role === "tool") {
    aMessages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]
    });
  } else if (m.role === "assistant" && m.toolCalls?.length) {
    const parts: any[] = [];
    for (const tc of m.toolCalls) parts.push({ type: "tool_use", id: tc.id, name: tc.name, input: {} });
    aMessages.push({ role: "assistant", content: parts });
  } else {
    aMessages.push({ role: m.role, content: m.content });
  }
}
console.log(JSON.stringify(aMessages, null, 2));
