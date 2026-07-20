// Runs blocking, before the stylesheets, so the saved theme applies with no flash.
document.documentElement.dataset.theme = localStorage.getItem("theme") || "light";
