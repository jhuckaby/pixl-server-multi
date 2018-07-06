// Multi-Server Cluster Manager
// A component for the pixl-server daemon framework.
// Copyright (c) 2015 Joseph Huckaby
// Released under the MIT License

var Class = require("pixl-class");
var Component = require("pixl-server/component");
var Tools = require("pixl-tools");
var dgram = require("dgram");
var os = require('os');
var Netmask = require('netmask').Netmask;

module.exports = Class.create({
	
	__name: 'MultiServer',
	__parent: Component,
	
	defaultConfig: {
		comm_port: 3014,
		heartbeat_freq: 20,
		check_beats: 3,
		exit_on_conflict: false
	},
	
	servers: null,
	listener: null,
	master: false,
	slave: false,
	eligible: true,
	hostname: '',
	masterHostname: '',
	data: null,
	
	startup: function(callback) {
		// startup
		var self = this;
		this.hostname = this.server.hostname;
		
		// emit events in outer server as well
		this.on('master', function() { self.server.emit('master'); } );
		this.on('slave', function() { self.server.emit('slave'); } );
		
		// user data system
		this.data = {};
		
		// setup initial cluster
		this.servers = {};
		this.servers[ this.hostname ] = {
			hostname: this.hostname,
			ip: this.server.ip,
			master: 0,
			eligible: this.eligible ? 1 : 0,
			self: 1,
			now: Tools.timeNow(),
			uptime: 0,
			data: this.data
		};
		
		// guess best broadcast IP
		this.broadcastIP = this.config.get('broadcast_ip') || this.calcBroadcastIP();
		this.logDebug(4, "Using broadcast IP: " + this.broadcastIP );
		
		// start heartbeat tickers
		this.tickTimer = setInterval( 
			function() { self.tick(); }, 
			this.config.get('heartbeat_freq') * 1000 
		);
		this.tockTimer = setInterval( 
			function() { self.tock(); }, 
			this.config.get('heartbeat_freq') * 1000 * this.config.get('check_beats')
		);
		
		// start UDP socket listener
		this.logDebug(4, "Starting UDP server on port: " + this.config.get('comm_port'));
		var listener = this.listener = dgram.createSocket("udp4");
		
		listener.on("message", function (msg, rinfo) {
			self.receive( msg, rinfo );
		} );
		
		listener.on("error", function (err) {
			self.logError(1, "UDP socket listener error: " + err);
			// if we got an error during startup, shut down now
			if (!self.server.started) self.server.shutdown();
		} );
		
		listener.bind( this.config.get('comm_port'), function() {
			callback();
		} );
		
		this.tick();
	},
	
	receive: function(msg, rinfo) {
		// receive UDP message from another server
		this.logDebug(10, "Received UDP message: " + msg + " from " + rinfo.address + ":" + rinfo.port);
		
		var text = msg.toString();
		if (text.match(/^\{/)) {
			// appears to be JSON
			var json = null;
			try { json = JSON.parse(text); }
			catch (e) {
				this.logError(1, "Failed to parse JSON message: " + e);
			}
			if (json && json.action) {
				switch (json.action) {
					case 'heartbeat':
						if (json.hostname) {
							json.now = Tools.timeNow();
							if (json.hostname == this.hostname) {
								json.self = 1;
								json.data = this.data;
							}
							delete json.action;
							if (!this.servers[ json.hostname ]) {
								// first time we've seen this server
								this.servers[ json.hostname ] = json;
								this.emit('addserver', json );
							}
							else {
								// update from existing server
								this.servers[ json.hostname ] = json;
							}
							this.logDebug(10, "Received heartbeat from: " + json.hostname, json);
						}
					break;
					
					case 'shutdown':
						// server is shutting down, update cluster immediately
						this.logDebug(9, "Received shutdown notice from: " + json.hostname, json);
						if (this.servers[ json.hostname ]) {
							this.servers[ json.hostname ].now = 1;
							this.tock();
						}
					break;
				} // switch action
			} // got json
		} // appears to be json
	},
	
	tick: function() {
		// broadcast heartbeat tick (every N seconds)
		var self = this;
		var now = Tools.timeNow(true);
		if (this.shut) return;
		
		this.broadcast( 'heartbeat', {
			hostname: this.hostname,
			ip: this.server.ip,
			master: this.master ? 1 : 0,
			eligible: this.eligible ? 1 : 0,
			uptime: now - (this.server.started || now),
			data: this.data
		} );
	},
	
	tock: function() {
		// master cluster check
		if (this.shut) return;
		var now = Tools.timeNow();
		var max_time = this.config.get('heartbeat_freq') * this.config.get('check_beats');
		
		// for sanity's sake, assume we are always active
		this.servers[ this.hostname ].now = now;
				
		// first, prune any servers which didn't report in
		for (var hostname in this.servers) {
			var server = this.servers[hostname];
			if (!server.self && !server.locked && (server.now < now - max_time)) {
				this.logDebug(8, "Removing dead server from cluster: " + hostname);
				delete this.servers[hostname];
				this.emit('deleteserver', server);
				
				// reset masterHostname if the dead server was master
				if (hostname == this.masterHostname) this.masterHostname = '';
			}
		}
		
		// locate current master hostname, if any
		for (var hostname in this.servers) {
			var server = this.servers[hostname];
			if (server.master) {
				if ((hostname != this.masterHostname) && (hostname != this.hostname)) {
					this.logDebug(6, "The master server is now: " + hostname);
					this.logDebug(9, "Current server cluster: " + Tools.hashKeysToArray(this.servers).join(', '));
				
					this.masterHostname = hostname;
					if (!this.slave) {
						// become a slave now
						this.slave = true;
						this.emit('slave');
					}
				} // new master
				break;
			} // found master
		} // foreach server
		
		if (!this.masterHostname && !this.master && this.eligible) {
			// determine if we need to become master
			var found_higher = false;
			for (var hostname in this.servers) {
				var server = this.servers[hostname];
				if (server.eligible && (hostname < this.hostname)) {
					found_higher = true;
					break;
				}
			} // foreach server
			
			if (!found_higher) {
				// we become master!
				this.logDebug(4, "We are now the master server");
				this.logDebug(9, "Current server cluster: " + Tools.hashKeysToArray(this.servers).join(', '));
				this.slave = false;
				this.master = true;
				this.masterHostname = this.hostname;
				this.servers[ this.hostname ].master = true;
				this.emit('master');
				this.tick();
			}
		} // no master yet
		
		// sanity check -- only one master allowed
		if (this.master) {
			for (var hostname in this.servers) {
				var server = this.servers[hostname];
				if (server.master && !server.self && (hostname != this.hostname)) {
					// conflict!  relinquish immediately!
					this.logDebug(1, "MASTER CONFLICT: "+hostname+" also thinks she is master!");
					if (this.config.get('exit_on_conflict')) {
						this.logDebug(1, "The server is shutting down due to master conflict.");
						this.server.shutdown();
					}
					else {
						this.relinquish();
					}
					break;
				}
			} // foreach hostname
		} // we are master
	},
	
	relinquish: function() {
		// relinquish master control
		if (this.master) {
			this.logDebug(1, "We are relinquishing master control");
			this.master = false;
			this.slave = true;
			this.masterHostname = '';
			this.servers[ this.hostname ].master = false;
			this.emit('slave');
			this.tick();
		}
	},
	
	broadcast: function(type, message, callback) {
		// broadcast message via UDP
		var self = this;
		
		message.action = type;
		this.logDebug(10, "Broadcasting message: " + type, message);
		
		var client = dgram.createSocket('udp4');
		var message = Buffer.from( JSON.stringify(message) + "\n" );
		client.bind( 0, function() {
			client.setBroadcast( true );			
			client.send(message, 0, message.length, self.config.get('comm_port'), self.broadcastIP, function(err) {
				if (err) self.logDebug(9, "UDP broadcast failed: " + err);
				client.close();
				if (callback) callback();
			} );
		} );
	},
	
	calcBroadcastIP: function() {
		// Attempt to determine server's Broadcast IP, using the first LAN IP and Netmask
		// https://en.wikipedia.org/wiki/Broadcast_address
		var ifaces = os.networkInterfaces();
		var addrs = [];
		for (var key in ifaces) {
			if (ifaces[key] && ifaces[key].length) {
				Array.from(ifaces[key]).forEach( function(item) { addrs.push(item); } );
			}
		}
		var addr = Tools.findObject( addrs, { family: 'IPv4', internal: false } );
		if (addr && addr.address && addr.address.match(/^\d+\.\d+\.\d+\.\d+$/)) {
			// well that was easy
			var ip = addr.address;
			var mask = addr.netmask;
			var block = new Netmask( ip + '/' + mask );
			return block.broadcast;
		}
		return '255.255.255.255';
	},
	
	shutdown: function(callback) {
		// shutdown
		var self = this;
		this.shut = true;
		
		// shutdown UDP listener
		if (this.listener) {
			this.logDebug(2, "Shutting down UDP server");
			this.listener.close();
		}
		
		if (this.tickTimer) {
			clearTimeout( this.tickTimer );
			delete this.tickTimer;
		}
		if (this.tockTimer) {
			clearTimeout( this.tockTimer );
			delete this.tockTimer;
		}
		
		// broadcast our shutdown to the cluster
		this.broadcast( 'shutdown', { hostname: this.hostname }, callback );
	}

});
