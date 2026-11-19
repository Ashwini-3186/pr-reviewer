const res = await fetch("https://openrouter.ai/api/v1/models");
const { data } = await res.json();

data
  .filter((m) => m.pricing.prompt === "0" && m.pricing.completion === "0")
  .forEach((m) => console.log(m.id));