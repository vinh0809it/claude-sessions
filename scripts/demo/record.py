import os, pty, sys, time, select, re, fcntl, termios, struct
from PIL import Image, ImageDraw, ImageFont
D=sys.argv[1]; IDX=sys.argv[2]
COLS,ROWS=104,24
FS=15
FONT=ImageFont.truetype('/usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Regular.ttf',FS)
BOLD=ImageFont.truetype('/usr/share/fonts/adwaita-mono-fonts/AdwaitaMono-Bold.ttf',FS)
CW=round(FONT.getlength('M')); CH=FS+6; PADX,PADY=14,12
BG=(30,30,46); FG=(205,214,244)
PAL={30:(69,71,90),31:(243,139,168),32:(166,227,161),33:(249,226,175),34:(137,180,250),35:(245,194,231),36:(148,226,213),37:(186,194,222),
     90:(88,91,112),91:(243,139,168),92:(166,227,161),93:(249,226,175),94:(137,180,250),95:(245,194,231),96:(137,220,235),97:(255,255,255)}
BGPAL={40:(24,24,37),44:(49,50,68)}

class Screen:
    def __init__(s): s.reset()
    def reset(s):
        s.cells=[[(' ',None) for _ in range(COLS)] for _ in range(ROWS)]; s.r=s.c=0; s.attr={}
    def put(s,ch):
        if ch=='\r': s.c=0; return
        if ch=='\n': s.r=min(ROWS-1,s.r+1); return
        if s.c<COLS and s.r<ROWS: s.cells[s.r][s.c]=(ch,dict(s.attr))
        s.c+=1
    def sgr(s,params):
        ps=[int(p) if p else 0 for p in params.split(';')] if params else [0]
        i=0
        while i<len(ps):
            p=ps[i]
            if p==0: s.attr={}
            elif p==1: s.attr['b']=1
            elif p==2: s.attr['dim']=1
            elif p==7: s.attr['inv']=1
            elif p==38 and i+2<len(ps) and ps[i+1]==5: s.attr['fg']=(215,119,87); i+=2
            elif p in PAL: s.attr['fg']=PAL[p]
            elif p in BGPAL: s.attr['bg']=BGPAL[p]
            i+=1
    def feed(s,data):
        for m in re.finditer(r'\x1b\[([?0-9;]*)([A-Za-z])|([^\x1b])',data):
            if m.group(3) is not None: s.put(m.group(3)); continue
            p,cmd=m.group(1),m.group(2)
            if cmd=='H':
                a=(p or '1;1').split(';'); s.r=int(a[0] or 1)-1; s.c=int(a[1] if len(a)>1 else 1)-1
            elif cmd=='K':
                for c in range(COLS): s.cells[s.r][c]=(' ',None)
            elif cmd=='J': s.reset()
            elif cmd=='m': s.sgr(p)
    def image(s):
        img=Image.new('RGB',(COLS*CW+2*PADX,ROWS*CH+2*PADY),BG); d=ImageDraw.Draw(img)
        for r,row in enumerate(s.cells):
            for c,(ch,a) in enumerate(row):
                a=a or {}; fg=a.get('fg',FG); bg=a.get('bg')
                if a.get('dim'): fg=tuple(int(x*0.55+BG[i]*0.45) for i,x in enumerate(fg))
                if a.get('inv'): fg,bg=(BG,(137,180,250))
                x,y=PADX+c*CW,PADY+r*CH
                if bg: d.rectangle([x,y,x+CW,y+CH],fill=bg)
                if ch!=' ': d.text((x,y+2),ch,font=BOLD if a.get('b') else FONT,fill=fg)
        return img

env=dict(os.environ,HOME=D+'/home',PATH=D+'/bin:'+os.environ['PATH'],TERM='xterm-256color',XDG_CACHE_HOME=D+'/cache')
for k in ['TMUX','KITTY_WINDOW_ID','WEZTERM_PANE','CLAUDE_SESSIONS_TERMINAL','TERM_PROGRAM','CLAUDE_CONFIG_DIR']: env.pop(k,None)
pid,fd=pty.fork()
if pid==0:
    os.chdir(D+'/home'); os.execvpe('node',['node',IDX],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',ROWS,COLS,0,0))
scr=Screen(); frames=[]
def pump(t):
    end=time.time()+t
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.03)
        if r:
            try: scr.feed(os.read(fd,65536).decode('utf8','replace'))
            except OSError: return
def shot(dur):
    pump(0.15); n=len(frames); f=f'{D}/frames/{n:04d}.png'; scr.image().save(f); frames.append((f,dur))
def key(k,dur=0.5): os.write(fd,k.encode()); shot(dur)
def typ(text,dur=0.12):
    for ch in text: key(ch,dur)

pump(1.2); shot(1.8)
key('j',0.45); key('j',0.45); key('j',0.9)
key('p',2.6)                         # preview
key('k',1.6); key('k',1.8)
key('/',0.5); typ('webhook'); shot(1.6); key('\r',0.6); key('\x1b',0.8)
key('s',1.3); key('s',1.6); key('s',0.6)   # sort size -> name -> date
key('G',0.5); key('r',0.6)
os.write(fd,b'\x7f'*60); typ('terminal-roguelike'); shot(0.8); key('\r',1.6)
key('G',0.6); key(' ',0.6); key('k',0.3); key('k',0.3); key('k',0.3); key('k',0.4); key(' ',0.9); key('d',1.8); key('y',2.0)  # bulk delete
key('g',0.6)
os.write(fd,b'o'); time.sleep(0.6); shot(2.0); pump(2.2); shot(1.3)       # resume in place, come back
key('?',2.8); key('x',0.5)
os.write(fd,b'q'); pump(0.3)
with open(f'{D}/frames.txt','w') as f:
    for p,d in frames: f.write(f"file '{p}'\nduration {d}\n")
    f.write(f"file '{frames[-1][0]}'\n")
print(len(frames),'frames', sum(d for _,d in frames),'s')
