"""Small stdlib JSONL transport to a private shared worker (no model imports)."""
import argparse
import json
import socket
import sys
from urllib.parse import urlsplit


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--socket",required=True)
    p.add_argument("--seed",type=int,required=True)
    p.add_argument("--game",required=True)
    p.add_argument("--side",choices=["p1","p2"],required=True)
    p.add_argument("--team-file",required=True)
    p.add_argument("--model",default="G0")
    p.add_argument("--temperature",type=float,default=1.)
    p.add_argument("--policy-id",default="metamon:Kakuna:epoch34")
    a = p.parse_args()
    endpoint=urlsplit(a.socket) if a.socket.startswith('tcp://') else None
    if endpoint and (endpoint.hostname!='127.0.0.1' or not endpoint.username or not endpoint.port):
        raise ValueError('Authenticated loopback worker endpoint required')
    with socket.socket(socket.AF_INET if endpoint else socket.AF_UNIX,socket.SOCK_STREAM) as sock:
        sock.connect((endpoint.hostname,endpoint.port) if endpoint else a.socket)
        stream = sock.makefile("rwb",buffering=0)
        stream.write((json.dumps(vars(a))+"\n").encode())
        ready = json.loads(stream.readline())
        if ready != {"ready":True}:
            raise RuntimeError(ready)
        for line in sys.stdin.buffer:
            if len(line)>262144:
                raise ValueError("Oversize worker frame")
            stream.write(line)
            reply = stream.readline(262145)
            if not reply.endswith(b"\n"):
                raise RuntimeError("Shared worker closed or oversize reply")
            sys.stdout.buffer.write(reply)
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
