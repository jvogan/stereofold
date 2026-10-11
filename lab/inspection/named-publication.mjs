/** Hold external save/broadcast callbacks until a named transaction confirms. */
export function createNamedPublication(publish) {
  let held=false, pending;
  return {
    mutation(snapshot) { if(held) pending=snapshot; else publish(snapshot); },
    async run(action,{publishAfter=false}={}) {
      if(held) throw Error('A named view transaction already owns publication.');
      held=true; pending=undefined;
      let confirmed=false;
      try { const result=await action(); confirmed=true; return result; }
      finally {
        const finalSnapshot=pending; held=false; pending=undefined;
        if(confirmed && publishAfter && finalSnapshot!==undefined) {
          // Observer failures must not reinterpret an already confirmed command.
          try { publish(finalSnapshot); } catch { /* Match viewer callback isolation. */ }
        }
      }
    },
  };
}
