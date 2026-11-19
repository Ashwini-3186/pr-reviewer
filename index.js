import express from "express";
const app=express();
app.use(express.json());

app.get("/",(req,res)=>{
    res.send("bot is running !");
});
app.post("/webhook",(req,res)=>{
    console.log("webhook recieved!");
    res.sendStatus(200);
});
app.listen(3000,()=>console.log("Running on http://localhost:3000"));