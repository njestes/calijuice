
# juicefeed

The following info is a guide to setting up a basic node.js/express web server on a raspberry pi.  A database will be created and populated with juice info from a cron script run every 15 minutes.  Additionally, an express server will be installed that hosts a static web page (Juice Feed) which queries the aforementioned database for juice infos and displays chronologically sorted, filterable juice info cards.

![Screen Shot](https://image.ibb.co/nqrZOA/Capture.png)

## Requirements

  **Hardware** (Monitor and keyboard only necessary for initial setup):  
  - raspberry pi microSD card  
  - micro USB power supply  
  - HDMI cable  
  - monitor  
  - keyboard  


  **Software**: 
  - Rasbian OS image (tesed using **June 2018** release) [here](https://www.raspberrypi.org/downloads/raspbian/)
  - Raspberry Pi image flashing software Etcher [here](https://etcher.io)
  - Putty SSH Client (optional) [here](https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html)

## Install raspbian

Follow steps from raspbian installation guide [here](https://www.raspberrypi.org/documentation/installation/installing-images/README.md)

- Flash image to microSD card using Etcher.io
- Insert microSD card into pi and plug in

## Configure raspbian

Once the pi has booted, log in using: user `pi` password `raspberry`

Run `sudo raspi-config` to run raspberry pi config wizard:

- setup and enable wifi [optional] (network options)
- enable SSH for remote access (interface options)
- set keyboard layout (localization options)
- set timezone (localization options)
- require user to log in (boot options/ Desktop/CLI)

**Wireless config**:  
Use `raspi-config` tool network options

**Wired config (using DHCP)**:  
Shouldn't have to do anything

**Wired config (static IP)**:  
edit IP configuration file: `sudo nano /etc/dhcpcd.conf` add the following to the bottom of the file (ensure the static IP being set is not already in use on the network).

```
#static IP configuration 

interface eth0
static ip_address=192.168.50.50/24 
static routers=192.168.50.1 
static domain_name_servers=192.168.50.1
```

Reboot necessary after any network configuration change:  
`sudo reboot` 

Get your pi's IP address, record the IP address from the following command:    
`hostname -I`

## Use SSH for remaining configuration steps

Using your SSH client, enter the IP address found above to connect to your Pi:  
`ssh pi@192.168.1.195`

### Create a new user

Add a new user, and delete default 'pi' user:  
 `sudo adduser hawdis`

To make new user part of the sudo group:  
`sudo adduser hawdis sudo`  

Reboot:  
`sudo reboot`

Your SSH session will disconnect.  Wait a minute or two and login with Putty again as your new user:  
`ssh hawdis@192.168.1.195`

Delete 'pi' user:  
`sudo deluser --remove-home pi`  

### Install system wide app dependencies

Update rasbian:  
`sudo apt-get update` then `sudo apt-get upgrade`

get required software from package manager:  
`sudo apt-get install -y git mariadb-server ufw`

Allow access to ports:  
`sudo ufw allow 8082`  
`sudo ufw allow 22`  

Enable firewall:  
`sudo ufw enable`  

Install latest node.js for your version of raspberry pi:  
`wget -O - https://raw.githubusercontent.com/audstanley/NodeJs-Raspberry-Pi/master/Install-Node.sh | sudo bash`

### mariadb setup
create new database user and set password.  This needs to be done using 'root':   
`sudo mysql -u root`  

you are now at the mysql prompt.  Now create the user and grant all privileges (replace 'hawdis' and 'abc123'):  
```GRANT ALL PRIVILEGES ON *.* TO 'hawdis'@'localhost' IDENTIFIED BY 'abc123';``` 

quit mysql:  
`\q`  

log back in as your new user:  
```mysql -u hawdis -p```  

create new database:  
```CREATE DATABASE juicedb;```  

quit mysql:  
`\q`  

### install and configure juicefeed app 
clone from github:  
`git clone https://github.com/marsmith/juicefeed`

enter project folder:  
`cd juicefeed`   

install npm dependencies:   
`npm install`

Edit dbInfo.js file with your user credentials
`nano dbInfo.js`  

Edit config file and replace juice venue values as needed.  This will configure your custom version of the juicefeed to suit your needs.  
`nano config.js`  

setup up cron jobs.  cron is a special file that will execute tasks at a predefined interval.  
`crontab -e`  Choose your editor of choice, I like nano.

The entry below will run the 'getJuice.js' node script every 15 minutes to pull new juice data.  Enter this on an empty line, where 'hawdis' is your username/home directory:  
```
*/15 * * * * /usr/bin/node /home/hawdis/juicefeed/getJuice.js
```

### Test your new juicefeed server  
Run script manually for the first time at debug log level, check console log for errors:  
`node getJuice.js debug`

Start up express server (stays running until CTRL-C):  
`node server.js`

Open a browser on another computer/mobile device connected to the same network using the IP address found above as the URL ie.:
`http://192.168.1.195:8082`

### Persistently start and keep the node/express server script running (optional):
install pm2:  
`sudo npm install pm2 -g`

create symlink for pm2 to enable user run:  
`sudo ln -s /opt/nodejs/bin/pm2 /usr/bin/pm2`

start pm2 (replace 'hawdis' with your username/home directory):  
`pm2 start /home/hawdis/juicefeed/server.js`  
`pm2 startup`  
`sudo env PATH=$PATH:/opt/nodejs/bin /opt/nodejs/lib/node_modules/pm2/bin/pm2 startup systemd -u hawdis --hp /home/hawdis`  
