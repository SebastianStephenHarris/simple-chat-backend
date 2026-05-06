let ws;
let username;
let userColor;
let replyingTo = null;
let isTabActive = true;
let typingTimeout;

// Track tab visibility (notifications)
document.addEventListener("visibilitychange", () => {
  isTabActive = !document.hidden;

  if (isTabActive) {
    document.title = "Simple Web Chat";
  }
});

// Enter chat
function enterChat() {
  username = document.getElementById("username").value.trim();
  userColor = document.getElementById("color").value;

  if (!username) return alert("Enter a username!");

  document.getElementById("login").style.display = "none";
  document.getElementById("chat").style.display = "block";

  ws = new WebSocket("wss://simple-chat-backend-1rop.onrender.com");

  ws.onmessage = event => {
    const data = JSON.parse(event.data);

    if (data.type === "message") {
      addMessage(data);
    }

    if (data.type === "typing") {
      // ✅ FIX: don't show your own typing
      if (data.username !== username) {
        showTyping(data);
      }
    }

    if (!isTabActive && data.type === "message") {
      document.title = "(New Message) Simple Web Chat";
    }
  };
}

// Send message
document.getElementById("messageInput").addEventListener("keypress", e => {
  if (e.key === "Enter" && ws) {
    const input = document.getElementById("messageInput");
    const text = input.value.trim();
    if (!text) return;

    ws.send(JSON.stringify({
      type: "message",
      username,
      color: userColor,
      text,
      reply: replyingTo
    }));

    replyingTo = null;
    input.value = "";
    input.placeholder = "Type a message and press Enter";
  }
});

// Typing indicator sender
document.getElementById("messageInput").addEventListener("input", () => {
  if (!ws) return;

  ws.send(JSON.stringify({
    type: "typing",
    username
  }));

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {}, 1000);
});

// Add message to UI
function addMessage(data) {
  const messages = document.getElementById("messages");

  const wrapper = document.createElement("div");
  wrapper.classList.add("message");

  const isMine = data.username === username;
  wrapper.classList.add(isMine ? "mine" : "theirs");

  const bubble = document.createElement("div");
  bubble.classList.add("bubble");
  bubble.style.borderColor = data.color;

  if (data.reply) {
    const replyDiv = document.createElement("div");
    replyDiv.classList.add("reply");
    replyDiv.textContent = "Replying to: " + data.reply;
    bubble.appendChild(replyDiv);
  }

  const name = document.createElement("strong");
  name.textContent = data.username;
  name.style.color = data.color;

  const text = document.createElement("div");
  text.textContent = data.text;

  const replyBtn = document.createElement("button");
  replyBtn.textContent = "Reply";
  replyBtn.onclick = () => setReply(data.text);

  bubble.appendChild(name);
  bubble.appendChild(document.createElement("br"));
  bubble.appendChild(text);
  bubble.appendChild(replyBtn);

  wrapper.appendChild(bubble);
  messages.appendChild(wrapper);

  messages.scrollTop = messages.scrollHeight;
}

// Set reply
function setReply(text) {
  replyingTo = text;
  document.getElementById("messageInput").placeholder = "Replying...";
}

// Show typing indicator
function showTyping(data) {
  let typingDiv = document.getElementById("typing");

  if (!typingDiv) {
    typingDiv = document.createElement("div");
    typingDiv.id = "typing";
    typingDiv.style.marginTop = "10px";
    document.body.appendChild(typingDiv);
  }

  typingDiv.textContent = `${data.username} is typing...`;

  setTimeout(() => {
    typingDiv.textContent = "";
  }, 1000);
}
