let ws;
let username;

function enterChat() {
  username = document.getElementById("username").value.trim();
  if (!username) return alert("Enter a username!");
  
  document.getElementById("login").style.display = "none";
  document.getElementById("chat").style.display = "block";

  // Set your Render WebSocket URL here:
  ws = new WebSocket("wss://simple-chat-backend-1rop.onrender.com");

  ws.onmessage = event => {
    const div = document.createElement("div");
    div.textContent = event.data;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  };
}

document.getElementById("messageInput").addEventListener("keypress", e => {
  if (e.key === "Enter" && ws) {
    ws.send(username + ": " + document.getElementById("messageInput").value);
    document.getElementById("messageInput").value = "";
  }
});