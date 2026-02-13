import express from "express";
import {runPipeline,getJobs,getJobById} from "./pipeline.js";
import {redis} from "./redisClient.js";
import sqlite3 from "sqlite3";
import {open} from "sqlite";
import "dotenv/config";

const app=express();
app.use(express.json());
const PORT=process.env.PORT||4000;

async function openDB(){
    return open({
        filename:"history.db",
        driver:sqlite3.Database
    });
}

app.get("/",(req,res)=>{
    res.send("CICD running successfully!");
});

app.post("/webhook",async(req,res)=>{
    console.log("Webhook received from github!");
    const event=req.headers["x-github-event"];
    const repo=req.body.repository?.name;
    const commitSha = req.body.after || req.body.head_commit?.id ||"unknown";
    const cloneUrl=req.body.repository?.clone_url;
    const ref=req.body.ref;
    const branch=ref?ref.split("/").pop():"unknown";
    console.log(`Event: ${event}`);
    console.log(`Repository name: ${repo}`);
    console.log(`branch: ${branch}`);
    console.log(`cloneUrl: ${cloneUrl}`);
    
    const db = await openDB();
    const result = await db.run(
        `INSERT INTO jobs (repo,branch,clone_url,commit_sha) VALUES (?,?,?,?)`,
        [repo,branch,cloneUrl,commitSha]
    );
    const jobId=result.lastID;
    await redis.lPush("ci:jobs",jobId.toString());
    console.log(`job ${jobId} enqueued`);
    res.status(200).send("job enqueued");
});

app.get("/jobs",async(req,res)=>{
    try {
        const jobs=await getJobs();
        res.json(jobs);
    } catch (error) {
        res.status(500).json({error:"failed to fetch job"});
    }
});

app.get("/jobs/:id",async(req,res)=>{
    const jobId=req.params.id;
    try {
        const job=await getJobById(jobId);
        if(!job){
            return res.status(404).json({error:"job not found"});
        }
        res.json(job);
    } catch (error) {
        res.status(500).json({error:"failed to fetch job"})
    }
});

app.listen(PORT, ()=>{
    console.log(`CICD-Builder running on ${PORT}`);
});