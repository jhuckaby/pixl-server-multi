# Overview

This module is a component for use in the [pixl-server](https://www.npmjs.com/package/pixl-server) framework.  It implements an automatic master/slave system between multiple servers running in the same LAN.  One server will always be master, and the rest will be slaves.  This allows you to run a cluster of daemons across multiple servers, and all the communication will be taken care of behind the scenes.  The servers all auto-discover each other, and auto-negotiate who becomes master.  All you have to do is listen for a couple of events.

## Behavior Rules

* Multiple servers auto-discover each other using UDP broadcast packets.
* All servers communicate with each other using "heartbeats" at preset intervals.
* Each server knows who is master, and all the other hostnames in the cluster.
* The time to determine a master server is `heartbeat_freq` multiplied by `check_beats`.  This time interval is known as a "tock".
* A single server running by itself will become master within 1 tock (default: 1 minute).
* If the master server disappears, crashes or shuts down, a slave will take over within 1 tock.
* With multiple servers, the hostname determines the priority (ranking).
* A server hostname that sorts alphabetically before another is more likely to become master.
* A server never relinquishes master privileges, unless it shuts down, or there is a conflict.
* Conflicts are resolved by all servers immediately relinquishing master control, and then allowing the cluster to recompute based on hostname.
* Conflicts should be virtually nonexistent, unless you have two servers with the same hostname, or network issues preventing heartbeats from arriving.

# Usage

Use [npm](https://www.npmjs.com/) to install the module:

```
	npm install pixl-server pixl-server-multi
```

Here is a simple usage example.  Note that the component's official name is `MultiServer`, so that is what you should use for the configuration key, and for gaining access to the component via your server object.

```javascript
	var PixlServer = require('pixl-server');
	var server = new PixlServer({
		
		__name: 'MyServer',
		__version: "1.0",
		
		config: {
			"log_dir": "/var/log",
			"debug_level": 9,
			
			"MultiServer": {
				"comm_port": 3014,
				"heartbeat_freq": 20,
				"check_beats": 3
			}
		},
		
		components: [
			require('pixl-server-multi')
		]
		
	});
	
	server.startup( function() {
		// server startup complete
	} );
	
	server.on('master', function() {
		// we just became the master server
	} );
	
	server.on('slave', function() {
		// we just became a slave server
	} );
```

Notice how we are loading the [pixl-server](https://www.npmjs.com/package/pixl-server) parent module, and then specifying [pixl-server-multi](https://www.npmjs.com/package/pixl-server-multi) as a component:

```javascript
	components: [
		require('pixl-server-multi')
	]
```

This example doesn't do much except startup and hook the `master` event, which fires when the server becomes master.  Note that this *only* happens on one single server in the cluster.  All the others will not receive this event, and will instead receive a `slave` event.  Note that it takes 1 tock (default: 1 minute) for the system to decide who is master and who are the slaves.

It is up to you to decide if your server should start performing slave or other operations on the `startup` event (which fires right away), or wait out the first tock (default 1 minute) until a master or slave decision is made.

# Configuration

The configuration for this component is set by passing in a `MultiServer` in the `config` element when constructing the `PixlServer` object, or, if a JSON configuration file is used, a `MultiServer` object at the outermost level of the file structure.  It should contain the following keys:

## comm_port

This is the UDP communication port to use when sending broadcast heartbeat packets.  All servers in your cluster must use the same port.  The default port is `3014`.

## heartbeat_freq

This is the number of seconds between sending each heartbeat, when the a UDP broadcast packet is sent to the rest of the cluster, updating our status.  The default is `20` seconds.

## check_beats

This is the number of heartbeats to perform a "tock" operation, which means the entire cluster will be examined to make sure that a master server is chosen and is healthy.  If not, one is chosen right away and all the master / slave events are sent.  The default is `3` heartbeats, meaning that a "tock" happens once per minute.

## broadcast_ip

Optionally override the broadcast IP address used to send out UDP pings.  If omitted, this is calculated from the server's IP address and netmask.  In most cases this works out of the box, and the `broadcast_ip` can be omitted, but it may be useful to specify if your server has multiple network interfaces.

## exit_on_conflict

This controls how the system will behave when a "master conflict" arises.  That is, when two servers both decide they are master.  This should theoretically never happen, but if it does, and this flag is set to `true`, the server will shut down.  The default is `false`, meaning the server will keep running but relinquish master control (i.e. it becomes a slave), and then let the cluster re-decide who should become the new master.

# Events

The MultiServer component emits the following events.  You can attach listeners using `server.MultiServer.on()` or just `server.on()`, as the events are also emitted on the outer [pixl-server](https://www.npmjs.com/package/pixl-server) object.

## master

The `master` event is emitted when a server becomes the master server of the cluster.  This will only happen on one server at any given time.

## slave

The `slave` event is emitted when a server becomes a slave.  That is, just after startup when a master server is chosen (and we aren't it), or when a conflict occurs (two masters at the same time -- very rare to nonexistent), and we are relinquishing control and downgrading from master to slave.

Your application should listen for this event, just in case it needs to stop being master.  However, it is generally safe to begin slave-type operations at startup, and not wait for the initial `slave` event to arrive.

## addserver

The `addserver` event is emitted when a new server appears, and is added to the cluster.  Your callback is passed an object describing the server, which will include a `hostname` and `ip`.

## deleteserver

The `deleteserver` event is emitted when a server is removed from the cluster.  Your callback is passed an object describing the server, which will include a `hostname` and `ip`.

# API

Here are some useful properties in the MultiServer object, which is accessible via the `MultiServer` properly in the main Server object:

```javascript
	var multi = server.MultiServer;
	
	var servers = multi.servers;
	var masterHostname = multi.masterHostname;
	var isMaster = multi.master;
	var isSlave = multi.slave;
	var isEligible = multi.eligible;
	var userData = multi.data;
```

## servers

The `servers` property is an object containing all the current servers in the cluster.  Each key is the server hostname, and the value is a sub-object with the following keys:

| Key | Description |
|-----|-------------|
| `hostname` | The server hostname (same as the key). |
| `master` | A boolean indicating if the server is the master (`true`) or not (`false`). |
| `eligible` | A boolean indicating if the server is eligible to become master (`true`) or not (`false`). |
| `self` | A boolean indicating if the server is the current server (`true`) or not (`false`). |
| `now` | An Epoch timestamp containing the last time the server sent a heartbeat. |
| `data` | A user accessible object containing custom data.  See [data](#data) below. |
| `uptime` | The number of seconds since the server was started up. |
| `locked` | Set this to `true` to prevent the server from ever being auto-removed (experimental feature, use at own risk). |

## masterHostname

The `masterHostname` property is a string containing the hostname of the current master server.  This will be blank during startup, before a master is chosen.  It may also be blank at any time, if the current master server shuts down, crashes, or disappears, before a new master is chosen.

## master

The `master` property is a boolean indicating whether the current server is the master (`true`) or not (`false`).

## slave

The `slave` property is a boolean indicating whether the current server is a slave (`true`) or not (`false`).

## eligible

The `eligible` property is a boolean indicating whether the current server is eligible to become master (`true`) or not (`false`).  This defaults to `true` but can be set to false if you want to prevent the server from becoming a master.

## data

The `data` property is a user-accessible object which you can populate with any keys/values you want.  This object and all of its contents are broadcasted to all other servers in the cluster every tick (default: 20 seconds).  Other servers can then access the data you broadcasted by looking in `multi.servers[HOSTNAME].data`.

Please do not stuff the `data` object with too much data.  It is serialized to JSON and broadcasted via UDP multiple times per minute on every server, so it is important to keep the packets small.

# License

The MIT License (MIT)

Copyright (c) 2015 - 2016 Joseph Huckaby.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
