// Confirms in the browser console that the script file is linked correctly
console.log("main.js loaded successfully");

// Toggle dark mode when the button is clicked
const themeBtn = document.getElementById("themeBtn");

themeBtn.addEventListener("click", () => {
  document.body.classList.toggle("dark");
});
