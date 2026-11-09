import os, json, sys, time
D=sys.argv[1]; H=D+'/home'
now=time.time()
def sess(profile, proj, sid, title, first, reply, size_kb, age_min):
    pdir=f'{H}/{profile}/projects/'+''.join(c if c.isalnum() else '-' for c in proj)
    os.makedirs(pdir, exist_ok=True); os.makedirs(proj, exist_ok=True)
    recs=[{'type':'user','message':{'content':first},'cwd':proj,'timestamp':'2026-11-01T00:00:00Z'},
          {'type':'assistant','message':{'content':[{'type':'text','text':reply}]}}]
    filler={'type':'assistant','message':{'content':[{'type':'tool_use','input':{'x':'y'*1000}}]}}
    lines=[json.dumps(r) for r in recs]+[json.dumps(filler)]*max(0,size_kb-1)
    lines+= [json.dumps({'type':'user','message':{'content':'and add a test for it'}}),
             json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':reply+' Added a regression test; all 38 tests pass.'}]}})]
    if title: lines.append(json.dumps({'type':'custom-title','customTitle':title}))
    f=f'{pdir}/{sid}.jsonl'; open(f,'w').write('\n'.join(lines)+'\n')
    t=now-age_min*60; os.utime(f,(t,t))
W=H+'/projects'
data=[
 ('.claude-work', f'{W}/acme/api', 'a1', 'booking-overlap-check', 'bookings can overlap when two requests arrive together', 'Wrapped the availability check and insert in one transaction with SELECT … FOR UPDATE.', 12300, 7),
 ('.claude-work', f'{W}/acme/api', 'a2', 'payment-webhook-retry', 'stripe webhooks get processed twice sometimes', 'Added an idempotency key table keyed by event id.', 3100, 55),
 ('.claude-work', f'{W}/acme/web', 'a3', 'checkout-a11y-pass', 'audit the checkout form for accessibility', 'Labels, focus order and error announcements are fixed.', 840, 190),
 ('.claude-work', f'{W}/acme/infra', 'a4', None, 'why is the staging pod OOMKilled every night', 'The nightly export loads the whole table into memory; switched to a cursor.', 5200, 400),
 ('.claude', f'{W}/blog', 'b1', 'astro-migration', 'move my blog from jekyll to astro', 'All 42 posts migrated; RSS and redirects kept.', 2400, 30),
 ('.claude', f'{W}/dotfiles', 'b2', 'nvim-lsp-setup', 'set up lsp for go and rust in neovim', 'gopls and rust-analyzer are wired up with format-on-save.', 420, 1500),
 ('.claude', f'{W}/side/game', 'b3', None, 'prototype a tiny roguelike in the terminal', 'Map generation and movement work; next is combat.', 1800, 3000),
]
for d in data: sess(*d)
