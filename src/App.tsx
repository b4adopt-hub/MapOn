    // 조례 안내 비동기 로드(DB) — 도착 시 행위제한을 등급에 반영
    setOrdinance(null);
    fetchOrdinance(land?.pnu, land?.primaryUseZone, purposes, slope?Number(slope):null)
      .then(ord=>{
        setOrdinance(ord);
        if(ord && ord.uses.length>0){
          setResults(prev=>prev.map(r=>applyOrdinance(r, ord)));
        }
      })
      .catch(()=>setOrdinance(null));