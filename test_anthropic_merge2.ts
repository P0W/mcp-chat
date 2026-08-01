const messages = [
  { role: "user", content: "foo" },
  { role: "assistant", toolCalls: [{id: "1", name: "t1"}, {id: "2", name: "t2"}] },
  { role: "tool", toolCallId: "1", content: "r1" },
  { role: "tool", toolCallId: "2", content: "r2" },
  { role: "user", content: "bar" }
];

const aMessages: any[] = [];
for (const m of messages) {
  let newMsg: any;
  if (m.role === "tool") {
    newMsg = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        },
      ],
    };
  } else if (m.role === "assistant" && m.toolCalls?.length) {
    const parts: any[] = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const tc of m.toolCalls)
      parts.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.args ?? {},
      });
    newMsg = { role: "assistant", content: parts };
  } else if (m.role === "user" || m.role === "assistant") {
    newMsg = { role: m.role, content: m.content };
  } else {
    continue;
  }

  const last = aMessages[aMessages.length - 1];
  if (last && last.role === newMsg.role) {
    let lastContent = last.content;
    if (typeof lastContent === "string") {
      lastContent = [{ type: "text", text: lastContent }];
    }
    let newContent = newMsg.content;
    if (typeof newContent === "string") {
      newContent = [{ type: "text", text: newContent }];
    } else if (!Array.isArray(newContent)) {
      newContent = [newContent];
    }
    last.content = lastContent.concat(newContent);
  } else {
    aMessages.push(newMsg);
  }
}
console.log(JSON.stringify(aMessages, null, 2));
