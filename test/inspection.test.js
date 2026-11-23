import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {createViewerServer} from "../server/http.js";

test("mock engine posts ordered results and streams a recoverable inspection snapshot", {timeout:15000}, async t=>{
  const server=createViewerServer({});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const url="http://127.0.0.1:"+server.address().port+"/api/inspection/";
  const abort=new AbortController();
  t.after(()=>{abort.abort();server.closeAllConnections();server.close();});
  const post=(path,body)=>fetch(url+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const events=async function*(){
    const res=await fetch(url+"stream",{signal:abort.signal}); let buffer="";
    for await(const chunk of res.body.pipeThrough(new TextDecoderStream())){
      buffer+=chunk;let end;
      while((end=buffer.indexOf("\n\n"))>=0){const entry=buffer.slice(0,end);buffer=buffer.slice(end+2);yield JSON.parse(entry.slice(6));}
    }
  };
  const stream=events();assert.equal((await stream.next()).value.run,null);
  const selection={selected:[2,6],files:["example.yaml"],device:"demo-device"};
  const start=await post("start",selection);assert.equal(start.status,202);
  assert.equal((await post("start",selection)).status,409);
  assert.equal((await post("reset",{})).status,409);
  const {id}=await start.json();
  assert.equal((await post("event",{id,item:6,type:"start"})).status,409);
  let active=new Set(), snapshot;
  for await(const state of stream){
    if(state.run.current!==null)active.add(state.run.current);
    if(state.run.status==="completed"){snapshot=state;break;}
  }
  assert.deepEqual([...active],[2,6]);assert.deepEqual(snapshot.run.results,["양호","판단 보류"]);
  assert.ok(snapshot.run.log.some(e=>e.text.includes("example.yaml")));
  assert.equal(snapshot.history.length,1);assert.equal(snapshot.history[0].rows.length,2);
  assert.equal((await post("event",{id,item:6,type:"result",result:"양호"})).status,409);
  assert.equal((await post("reset",{})).status,200);
  const reconnect=events();const restored=(await reconnect.next()).value;
  assert.equal(restored.run,null);assert.deepEqual(restored.history,snapshot.history);
  await reconnect.return();
});
