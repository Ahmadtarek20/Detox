describe('Genymotion-Cloud instance allocation', () => {
  const recipeUUID = 'mock-recipe-uuid';
  const recipeName = 'mock-recipe-name';

  let logger;
  let retry;
  let eventEmitter;
  let deviceRegistry;
  let deviceCleanupRegistry;
  let instanceLookupService;
  let instanceLifecycleService;
  let GenyInstance;
  let uut;
  beforeEach(() => {
    jest.mock('../../../../utils/logger');
    logger = require('../../../../utils/logger');

    jest.mock('../../../../utils/retry');
    retry = require('../../../../utils/retry');
    retry.mockImplementation((options, func) => func());

    const AsyncEmitter = jest.genMockFromModule('../../../../utils/AsyncEmitter');
    eventEmitter = new AsyncEmitter();

    const DeviceRegistry = jest.genMockFromModule('../../../../devices/DeviceRegistry');
    deviceRegistry = new DeviceRegistry();
    deviceRegistry.allocateDevice.mockImplementation((func) => func());
    deviceCleanupRegistry = new DeviceRegistry();

    const InstanceLookupService = jest.genMockFromModule('./services/GenyInstanceLookupService');
    instanceLookupService = new InstanceLookupService();

    const InstanceLifecycleService = jest.genMockFromModule('./services/GenyInstanceLifecycleService');
    instanceLifecycleService = new InstanceLifecycleService();

    GenyInstance = jest.genMockFromModule('./services/dto/GenyInstance');

    const InstanceAllocation = require('./GenyCloudInstanceAllocation');
    uut = new InstanceAllocation(deviceRegistry, deviceCleanupRegistry, instanceLookupService, instanceLifecycleService, eventEmitter);
  });

  const aRecipe = () => ({
    uuid: recipeUUID,
    name: recipeName,
    toString: () => 'mock-recipe-toString()',
  });

  const anOfflineInstance = () => {
    const instance = new GenyInstance();
    instance.uuid = 'mock-instance-uuid';
    instance.name = 'mock-instance-name';
    instance.isAdbConnected.mockReturnValue(false);
    instance.isOnline.mockReturnValue(false);
    instance.adbName = '0.0.0.0';
    instance.toString = () => 'mock-instance-toString()';
    return instance;
  };

  const anOnlineInstance = () => {
    const instance = anOfflineInstance();
    instance.isOnline.mockReturnValue(true);
    return instance;
  };

  const aFullyConnectedInstance = () => {
    const instance = anOnlineInstance();
    instance.isAdbConnected.mockReturnValue(true);
    instance.adbName = 'localhost:1234';
    return instance;
  };

  const aDisconnectedInstance = () => {
    const instance = anOnlineInstance();
    instance.isAdbConnected.mockReturnValue(false);
    return instance;
  };

  const givenFreeInstance = (instance) => instanceLookupService.findFreeInstance.mockResolvedValueOnce(instance)
  const givenNoFreeInstances = () => instanceLookupService.findFreeInstance.mockResolvedValue(undefined);
  const givenCreatedInstance = (instance) => instanceLifecycleService.createInstance.mockResolvedValueOnce(instance);
  const givenConnectionInstance = (instance) => instanceLifecycleService.adbConnectInstance.mockResolvedValue(instance);
  const givenRefreshedInstance = (instance) => instanceLookupService.getInstance.mockReturnValueOnce(instance);

  const expectDeviceBootEvent = (instance, recipe, coldBoot) =>
    expect(eventEmitter.emit).toHaveBeenCalledWith('bootDevice', {
      coldBoot,
      deviceId: instance.adbName,
      type: recipe.name,
    });

  describe('allocation', () => {
    it('should return a free device', async () => {
      const connectedInstance = aFullyConnectedInstance();
      givenFreeInstance(connectedInstance);
      givenConnectionInstance(connectedInstance);

      const result = await uut.allocateDevice(aRecipe());
      expect(result).toEqual(connectedInstance);
      expect(instanceLookupService.findFreeInstance).toHaveBeenCalledWith();
    });

    it('should adb-connect device if disconnected', async () => {
      const connectedInstance = aFullyConnectedInstance();
      const disconnectedInstance = aDisconnectedInstance();
      givenFreeInstance(disconnectedInstance);
      givenConnectionInstance(connectedInstance);

      const result = await uut.allocateDevice(aRecipe());
      expect(result).toEqual(connectedInstance);

      expect(instanceLifecycleService.adbConnectInstance).toHaveBeenCalledWith(disconnectedInstance.uuid);
    });

    it('should not connect a connected device', async () => {
      const connectedInstance = aFullyConnectedInstance();
      givenFreeInstance(connectedInstance);

      await uut.allocateDevice(aRecipe());

      expect(instanceLifecycleService.adbConnectInstance).not.toHaveBeenCalled();
    });

    it('should not connect inside locking callback (!!!)', async () => {
      const connectedInstance = aFullyConnectedInstance();
      const disconnectedInstance = aDisconnectedInstance();
      givenFreeInstance(disconnectedInstance);
      givenConnectionInstance(connectedInstance);

      deviceRegistry.allocateDevice.mockImplementation(async (func) => {
        const result = await func();
        expect(instanceLifecycleService.adbConnectInstance).not.toHaveBeenCalled();
        return result;
      });

      await uut.allocateDevice(aRecipe());
    });

    it('should create a device if no free one is available', async () => {
      const instance = aFullyConnectedInstance();
      givenNoFreeInstances();
      givenCreatedInstance(instance);

      const result = await uut.allocateDevice(aRecipe());
      expect(result).toEqual(instance);
      expect(instanceLifecycleService.createInstance).toHaveBeenCalledWith(recipeUUID);
    });

    it('should wait for a created device to become online', async () => {
      const instance = anOfflineInstance();
      const onlineInstance = aFullyConnectedInstance();
      givenNoFreeInstances();
      givenCreatedInstance(instance);
      givenRefreshedInstance(onlineInstance);
      givenConnectionInstance(onlineInstance);

      retry.mockImplementationOnce(async (options, func) => {
        const instance = await func();
        expect(instanceLookupService.getInstance).toHaveBeenCalledWith(instance.uuid);
        return instance;
      });

      const result = await uut.allocateDevice(aRecipe());
      expect(result).toEqual(onlineInstance);
      expect(retry).toHaveBeenCalled();
    });

    it('should fail if device never becomes online', async () => {
      const instance = anOfflineInstance();
      givenNoFreeInstances();
      givenCreatedInstance(instance);
      givenRefreshedInstance(instance);

      try {
        await uut.allocateDevice(aRecipe());
        fail('Expected an error');
      } catch (e) {
        expect(e.toString()).toContain(`Timeout waiting for instance ${instance.uuid} to be ready`);
      }
    });

    it('should not wait for created device to become online if already online', async () => {
      const instance = aFullyConnectedInstance();
      givenNoFreeInstances();
      givenCreatedInstance(instance);
      givenRefreshedInstance(instance);

      await uut.allocateDevice(aRecipe());
      expect(instanceLookupService.getInstance).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
    });

    it('should not wait for device to become online, inside locking callback (!!!)', async () => {
      const instance = anOfflineInstance();
      const onlineInstance = aFullyConnectedInstance();
      givenNoFreeInstances();
      givenCreatedInstance(instance);
      givenRefreshedInstance(onlineInstance);

      deviceRegistry.allocateDevice.mockImplementation(async (func) => {
        const result = await func();
        expect(instanceLookupService.getInstance).not.toHaveBeenCalled();
        return result;
      });

      await uut.allocateDevice(aRecipe());
    });

    it('should allocate device based on the instance\'s UUID', async () => {
      const instance = aFullyConnectedInstance();
      givenFreeInstance(instance);

      deviceRegistry.allocateDevice.mockImplementation(async (func) => {
        const result = await func();
        expect(result).toEqual(instance.uuid);
        return result;
      });

      await uut.allocateDevice(aRecipe());
      expect(deviceRegistry.allocateDevice).toHaveBeenCalled();
    });

    it('should register a new device for cleanup', async () => {
      const instance = aFullyConnectedInstance();
      givenNoFreeInstances();
      givenCreatedInstance(instance);

      await uut.allocateDevice(aRecipe());
      expect(deviceCleanupRegistry.allocateDevice).toHaveBeenCalledWith({
        uuid: instance.uuid,
        name: instance.name,
      });
    });

    it('should not register an existing device for cleanup', async () => {
      const instance = aFullyConnectedInstance();
      givenFreeInstance(instance);

      await uut.allocateDevice(aRecipe());
      expect(deviceCleanupRegistry.allocateDevice).not.toHaveBeenCalled();
    });

    it('should log pre-allocate message', async () => {
      givenFreeInstance(aFullyConnectedInstance());
      await uut.allocateDevice(aRecipe());
      expect(logger.debug).toHaveBeenCalledWith({ event: 'ALLOCATE_DEVICE' }, expect.stringContaining('Trying to allocate'));
      expect(logger.debug).toHaveBeenCalledWith({ event: 'ALLOCATE_DEVICE' }, expect.stringContaining('mock-recipe-toString()'));
    });

    it('should log post-allocate message', async () => {
      givenFreeInstance(aFullyConnectedInstance());
      await uut.allocateDevice(aRecipe());
      expect(logger.debug).toHaveBeenCalledWith({ event: 'ALLOCATE_DEVICE' }, expect.stringContaining(`Settled on mock-instance-toString()`));
      expect(logger.debug).toHaveBeenCalledTimes(2);
    });

    it('should emit a boot-device event for an existing instance', async () => {
      const instance = aFullyConnectedInstance();
      const recipe = aRecipe();
      givenFreeInstance(instance);

      await uut.allocateDevice(recipe);

      expectDeviceBootEvent(instance, recipe, false);
    });

    it('should emit a boot-device event for a new instance', async () => {
      const instance = aFullyConnectedInstance();
      const recipe = aRecipe();
      givenNoFreeInstances();
      givenCreatedInstance(instance);

      await uut.allocateDevice(recipe);

      expectDeviceBootEvent(instance, recipe, true);
    });

    it('should fail if event emission fails', async () => {
      const instance = aFullyConnectedInstance();
      givenFreeInstance(instance);

      eventEmitter.emit.mockRejectedValue(new Error());

      try {
        await uut.allocateDevice(aRecipe);
        fail('Expected an error');
      } catch(e) {}
    });

    it('should emit boot-device event *after* post-allocate log', async () => {
      const instance = aFullyConnectedInstance();
      givenFreeInstance(instance);

      eventEmitter.emit.mockRejectedValue(new Error());

      try {
        await uut.allocateDevice(aRecipe);
      } catch(e) {
        expect(logger.debug).toHaveBeenCalledTimes(2);
      }
    });
  });

  describe('Deallocation', () => {
    const givenAnInstanceDeletionError = () => instanceLifecycleService.deleteInstance.mockRejectedValue(new Error());

    it('should delete the associated instance', async () => {
      const instance = aFullyConnectedInstance();
      await uut.deallocateDevice(instance);
      expect(instanceLifecycleService.deleteInstance).toHaveBeenCalledWith(instance.uuid);
    });

    it('should fail if deletion fails', async () => {
      givenAnInstanceDeletionError();

      try {
        const instance = aFullyConnectedInstance();
        await uut.deallocateDevice(instance);
        fail('Expected an error');
      } catch (e) {}
    });

    it('should remove the instance from the cleanup registry', async () => {
      const instance = aFullyConnectedInstance();
      await uut.deallocateDevice(instance);
      expect(deviceCleanupRegistry.disposeDevice).toHaveBeenCalledWith(instance.uuid);
    });

    it('should emit associated events', async () => {
      const instance = aFullyConnectedInstance();
      await uut.deallocateDevice(instance);

      expect(eventEmitter.emit).toHaveBeenCalledWith('beforeShutdownDevice', { deviceId: instance.adbName });
      expect(eventEmitter.emit).toHaveBeenCalledWith('shutdownDevice', { deviceId: instance.adbName });
    });
  });
});